// Fonte nativa do Antigravity para o Habblaud (Windows / macOS / Linux, sem Docker ou WSL):
// observa os transcripts JSONL reais em ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
// e projeta o agente principal + subagentes (e suas atividades, tarefas, tokens e terminal) no escritório.
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  Activity,
  ActivityKind,
  AgentStats,
  AgentStatus,
  SourceInfo,
  TaskItem,
  TerminalEntry,
} from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';

const RECENT_WINDOW_MS = 2 * 60 * 60_000; // conversas modificadas nas últimas 2h
const WORKING_WINDOW_MS = 28_000; // escreveu nos últimos 28s = trabalhando
const ACCOUNT_ID = '.antigravity';

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  brainDir: string;
  pollMs?: number;
  now?: () => number;
}

export function discoverAntigravityDir(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const flag = env.HABBLAUD_ANTIGRAVITY?.trim();
  if (flag && /^(0|false|no|off)$/i.test(flag)) return undefined;
  const custom = env.HABBLAUD_ANTIGRAVITY_DIR?.trim();
  if (custom) return existsSync(custom) ? custom : undefined;
  const standard = join(home, '.gemini', 'antigravity', 'brain');
  return existsSync(standard) ? standard : undefined;
}

interface RawToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface RawStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  model?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  thinking?: string;
  content?: string;
  tool_calls?: RawToolCall[];
}

interface SubSpawnMeta {
  parentId: string;
  role: string;
  typeName?: string;
  createdAt: number;
}

interface ConvTracker {
  id: string;
  agentId: string;
  transcriptPath: string;
  offset: number;
  partial: string;
  inOffice: boolean;
  kind: 'main' | 'sub';
  parentConvId?: string;
  role: string;
  title?: string;
  cwd: string;
  model?: string;
  startedAt: number;
  lastEventAt: number;
  lastMtimeMs: number;
  lastStatus: AgentStatus;
  hasFinalReply: boolean;
  pendingSpawn?: { role: string; typeName?: string; at: number };
  stats: AgentStats;
  tasks: TaskItem[];
  subDone: boolean;
}

function unquote(v: unknown): string {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseTimestamp(v: unknown, fallback: number): number {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

function toPosixPath(p: string): string {
  return p.replace(/\\+/g, '/').replace(/\/+$/, '');
}

function inferProjectCwd(text: string): string | undefined {
  const norm = text.replace(/\\\\/g, '/').replace(/\\/g, '/');
  // 1. Projetos em ~/.gemini/antigravity/scratch/<projeto>
  const scratchMatch = norm.match(/([A-Za-z]:\/[^\s"'`]*?\/\.gemini\/antigravity\/scratch\/[^/\s"'`]+)/i);
  if (scratchMatch) return toPosixPath(scratchMatch[1]);
  // 2. Diretório habblaud ou outros projetos no perfil do usuário
  const habMatch = norm.match(/([A-Za-z]:\/Users\/[^/\s"'`]+\/habblaud)\b/i);
  if (habMatch) return toPosixPath(habMatch[1]);
  return undefined;
}

function describeToolCall(tc: RawToolCall, stepIndex: number, idx: number, at: number, convId: string): Activity | undefined {
  const name = tc.name ?? 'tool';
  const args = tc.args ?? {};
  const id = `agy:${convId}:${stepIndex}:t${idx}`;

  const make = (kind: ActivityKind, icon: string, text: string, detail?: string): Activity => ({
    id,
    kind,
    icon,
    text: truncate(maskSecrets(text), 46),
    ...(detail ? { detail: truncate(maskSecrets(detail), 300) } : {}),
    tool: name,
    at,
  });

  if (name === 'write_file') {
    const p = unquote(args.Path);
    return make('write', '📝', `Criando ${basename(p || 'arquivo')}`, p);
  }
  if (name === 'edit_file') {
    const p = unquote(args.Path);
    return make('edit', '✏️', `Editando ${basename(p || 'arquivo')}`, p);
  }
  if (name === 'read_file') {
    const p = unquote(args.Path);
    return make('read', '📖', `Lendo ${basename(p || 'arquivo')}`, p);
  }
  if (name === 'run_command') {
    const summary = unquote(args.toolSummary);
    const cmd = unquote(args.CommandLine);
    const isTest = /\b(test|vitest|jest|typecheck)\b/i.test(cmd);
    const isGit = /^\s*git\b/i.test(cmd);
    return make(
      isTest ? 'test' : isGit ? 'git' : 'run',
      isTest ? '🧪' : isGit ? '🌿' : '💻',
      summary || `Executando: ${truncate(cmd, 32)}`,
      cmd,
    );
  }
  if (name === 'search_web') {
    const q = unquote(args.query);
    return make('web', '🌐', `Pesquisando: ${truncate(q, 30)}`, q);
  }
  if (name === 'invoke_subagent') {
    const role = unquote(args.Role) || unquote(args.TypeName) || 'subagente';
    return make('delegate', '🤝', `Acionando ${role}`, role);
  }
  if (name === 'define_subagent') {
    const subName = unquote(args.Name) || 'agente';
    return make('plan', '🧩', `Contratando ${subName}`, subName);
  }
  if (name === 'send_message') {
    return make('communicate', '💬', 'Reportando para a equipe', unquote(args.Message));
  }
  if (name === 'update_focus') {
    const focus = unquote(args.focus);
    return make('plan', '🎯', focus || 'Atualizando foco', focus);
  }
  if (name === 'update_steps') {
    return make('plan', '📋', 'Atualizando plano da equipe');
  }
  if (name.startsWith('browser') || name === 'navigate' || name === 'click') {
    return make('browser', '🌍', `Navegador: ${name}`);
  }
  return make('other', '⚙️', `Usando ${name}`);
}

function parseStepsArg(args: Record<string, unknown> | undefined): TaskItem[] | undefined {
  if (!args || !args.steps) return undefined;
  let raw = args.steps;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(raw)) return undefined;
  const out: TaskItem[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const title = unquote(obj.title) || String(obj.title ?? '').trim();
    if (!title) return;
    const st = unquote(obj.status) || String(obj.status ?? 'pending');
    const status = st === 'done' ? 'completed' : st === 'in_progress' ? 'in_progress' : 'pending';
    out.push({ id: `step-${i + 1}`, title, status });
  });
  return out.length ? out : undefined;
}

export function createAntigravityTerminalParser(): TerminalParser {
  let seq = 0;
  return {
    push(line: string): TerminalEntry[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let step: RawStep;
      try {
        step = JSON.parse(trimmed) as RawStep;
      } catch {
        return [];
      }
      const at = parseTimestamp(step.created_at, Date.now());
      const out: TerminalEntry[] = [];
      const baseId = `agy-${step.step_index ?? ++seq}`;

      if (step.source === 'USER' && step.content) {
        out.push({ kind: 'user', id: `${baseId}-u`, at, text: truncate(maskSecrets(step.content), 4000) });
      }
      if (step.thinking) {
        out.push({ kind: 'thinking', id: `${baseId}-th`, at, text: truncate(maskSecrets(step.thinking), 2000) });
      }
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((tc, i) => {
          const name = tc.name ?? 'tool';
          const args = tc.args ?? {};
          const pathArg = unquote(args.Path);
          const cmdArg = unquote(args.CommandLine);
          const roleArg = unquote(args.Role);
          const shortArg = pathArg ? basename(pathArg) : cmdArg ? truncate(cmdArg, 50) : roleArg;
          out.push({
            kind: 'tool',
            id: `${baseId}-tc-${i}`,
            at,
            tool: name,
            title: shortArg ? `${name}(${shortArg})` : name,
            input: cmdArg || pathArg || (roleArg ? `Role: ${roleArg}` : undefined),
            inputKind: cmdArg ? 'command' : 'text',
          });
        });
      }
      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && step.content) {
        out.push({ kind: 'assistant', id: `${baseId}-a`, at, text: truncate(maskSecrets(step.content), 6000) });
      }
      return out;
    },
  };
}

export class AntigravitySource implements AgentSource {
  readonly provider = 'claude' as const;
  private readonly now: () => number;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trackers = new Map<string, ConvTracker>();
  private subSpawns = new Map<string, SubSpawnMeta>();
  private defaultCwd: string;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 1_000;
    this.defaultCwd = toPosixPath(join(opts.brainDir, '..', 'scratch', 'primeiro-app-mobile'));
  }

  start(): void {
    this.opts.accounts.setProviderAccounts('claude', [
      {
        dir: this.opts.brainDir,
        detected: {
          id: ACCOUNT_ID,
          configDir: this.opts.brainDir,
          short: 'A',
          name: 'Antigravity',
          color: '#4aa8e8',
          plan: 'Gemini Local',
        },
      },
    ]);

    this.opts.office.beginBoot();
    try {
      this.scan(true);
    } catch (err) {
      log.warn(`AntigravitySource boot error: ${errMsg(err)}`);
    } finally {
      this.opts.office.endBoot();
    }

    this.timer = setInterval(() => {
      try {
        this.scan(false);
      } catch (err) {
        log.warnOnce(`agy-scan:${errMsg(err)}`, `AntigravitySource scan error: ${errMsg(err)}`);
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    const active = [...this.trackers.values()].filter((t) => t.inOffice && t.lastStatus !== 'offline').length;
    return [
      {
        label: ACCOUNT_ID,
        provider: 'claude',
        path: this.opts.brainDir,
        ok: true,
        sessions: active,
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    for (const t of this.trackers.values()) {
      if (t.agentId === agentId) return t.transcriptPath;
    }
    return undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.transcriptPathOf(agentId) ? createAntigravityTerminalParser() : undefined;
  }

  private scan(isBoot: boolean): void {
    if (!existsSync(this.opts.brainDir)) return;
    const now = this.now();
    const dirs = readdirSync(this.opts.brainDir, { withFileTypes: true });
    const seen = new Set<string>();

    // Passo 1: descobrir arquivos recentes e atualizar leitura incremental
    const entries: Array<{ id: string; path: string; mtimeMs: number; size: number }> = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const tPath = join(this.opts.brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tPath)) continue;
      let st;
      try {
        st = statSync(tPath);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > RECENT_WINDOW_MS) continue;
      entries.push({ id: d.name, path: tPath, mtimeMs: st.mtimeMs, size: st.size });
    }

    // Ordenar: mais antigos primeiro para que o pai registre `subSpawns` antes do filho
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const e of entries) {
      seen.add(e.id);
      let trk = this.trackers.get(e.id);
      if (!trk) {
        const spawn = this.subSpawns.get(e.id);
        trk = {
          id: e.id,
          agentId: `${ACCOUNT_ID}:${e.id}`,
          transcriptPath: e.path,
          offset: 0,
          partial: '',
          inOffice: false,
          kind: spawn ? 'sub' : 'main',
          parentConvId: spawn?.parentId,
          role: spawn?.role ?? 'Tech Lead (Antigravity)',
          title: spawn?.role,
          cwd: this.defaultCwd,
          startedAt: spawn?.createdAt ?? e.mtimeMs,
          lastEventAt: e.mtimeMs,
          lastMtimeMs: e.mtimeMs,
          lastStatus: now - e.mtimeMs <= WORKING_WINDOW_MS ? 'working' : 'idle',
          hasFinalReply: false,
          stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
          tasks: [],
          subDone: false,
        };
        this.trackers.set(e.id, trk);
      }
      trk.lastMtimeMs = e.mtimeMs;
      const newActivities = this.readIncremental(trk, e.size);

      // Checa se agora sabemos que é subagente de um pai
      const spawn = this.subSpawns.get(trk.id);
      if (spawn && trk.kind !== 'sub') {
        trk.kind = 'sub';
        trk.parentConvId = spawn.parentId;
        trk.role = spawn.role;
        trk.title = spawn.role;
      }

      this.syncToOffice(trk, newActivities, now, isBoot);
    }

    // Passo 2: garantir que subagentes recém-vinculados sejam sincronizados depois que o pai entrou
    for (const trk of this.trackers.values()) {
      if (!seen.has(trk.id)) continue;
      if (trk.kind === 'sub' && !trk.inOffice && trk.parentConvId) {
        this.syncToOffice(trk, [], now, isBoot);
      }
    }
  }

  private readIncremental(trk: ConvTracker, fileSize: number): Activity[] {
    if (fileSize <= trk.offset) return [];
    const activities: Activity[] = [];
    let fd: number | undefined;
    try {
      fd = openSync(trk.transcriptPath, 'r');
      const toRead = fileSize - trk.offset;
      const buf = Buffer.alloc(Math.min(toRead, 2 * 1024 * 1024));
      const bytesRead = readSync(fd, buf, 0, buf.length, trk.offset);
      trk.offset += bytesRead;
      const chunk = trk.partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      trk.partial = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let step: RawStep;
        try {
          step = JSON.parse(line) as RawStep;
        } catch {
          continue;
        }
        const at = parseTimestamp(step.created_at, trk.lastMtimeMs);
        if (at < trk.startedAt) trk.startedAt = at;
        if (at > trk.lastEventAt) trk.lastEventAt = at;
        if (step.model) trk.model = step.model;

        if (typeof step.input_tokens === 'number') trk.stats.tokensIn += step.input_tokens;
        if (typeof step.cache_read_tokens === 'number') trk.stats.tokensIn += step.cache_read_tokens;
        if (typeof step.output_tokens === 'number') trk.stats.tokensOut += step.output_tokens;

        // Detecta criação de subagentes (conversationId no output GENERIC após invoke_subagent)
        if (step.type === 'GENERIC' && typeof step.content === 'string') {
          const matches = step.content.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/gi);
          for (const m of matches) {
            const subId = m[1];
            if (subId && subId !== trk.id && !this.subSpawns.has(subId)) {
              const role = trk.pendingSpawn?.role ?? 'Subagente Antigravity';
              this.subSpawns.set(subId, {
                parentId: trk.id,
                role,
                typeName: trk.pendingSpawn?.typeName,
                createdAt: at,
              });
              trk.stats.subagents += 1;
            }
          }
          const foundCwd = inferProjectCwd(step.content);
          if (foundCwd) trk.cwd = foundCwd;
        }

        if (step.source === 'USER' && typeof step.content === 'string') {
          const userMatch = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
          const clean = (userMatch ? userMatch[1] : step.content).trim();
          if (clean && !trk.title && trk.kind === 'main') {
            trk.title = truncate(clean, 60);
          }
          if (clean) {
            activities.push({
              id: `agy:${trk.id}:${step.step_index ?? 0}:prompt`,
              kind: 'prompt',
              icon: '💬',
              text: truncate(maskSecrets(clean), 46),
              at,
            });
          }
        }

        if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
          const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : [];
          if (tcs.length > 0) {
            trk.hasFinalReply = false;
            tcs.forEach((tc, idx) => {
              trk.stats.toolCalls += 1;
              if (tc.name === 'invoke_subagent') {
                trk.pendingSpawn = {
                  role: unquote(tc.args?.Role) || unquote(tc.args?.TypeName) || 'Subagente',
                  typeName: unquote(tc.args?.TypeName),
                  at,
                };
              }
              if (tc.name === 'update_steps') {
                const parsed = parseStepsArg(tc.args);
                if (parsed) trk.tasks = parsed;
              }
              const pathCandidate = unquote(tc.args?.Path) || unquote(tc.args?.CommandLine);
              if (pathCandidate) {
                const foundCwd = inferProjectCwd(pathCandidate);
                if (foundCwd) trk.cwd = foundCwd;
              }
              const act = describeToolCall(tc, step.step_index ?? 0, idx, at, trk.id);
              if (act) activities.push(act);
            });
          } else if (step.content) {
            trk.hasFinalReply = true;
            activities.push({
              id: `agy:${trk.id}:${step.step_index ?? 0}:resp`,
              kind: 'respond',
              icon: '✨',
              text: truncate(maskSecrets(step.content), 46),
              at,
            });
          } else if (step.thinking) {
            activities.push({
              id: `agy:${trk.id}:${step.step_index ?? 0}:think`,
              kind: 'think',
              icon: '🧠',
              text: truncate(maskSecrets(step.thinking), 46),
              at,
            });
          }
        }
      }
    } catch {
      // ignora erro transitório de leitura concorrente no Windows
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return activities;
  }

  private syncToOffice(trk: ConvTracker, newActivities: Activity[], now: number, isBoot: boolean): void {
    const recentlyModified = now - trk.lastMtimeMs <= WORKING_WINDOW_MS;
    const isWorking = recentlyModified && !trk.hasFinalReply;

    if (trk.kind === 'main') {
      const nextStatus: AgentStatus = isWorking ? 'working' : 'idle';
      if (!trk.inOffice) {
        this.opts.office.addMain({
          id: trk.agentId,
          account: ACCOUNT_ID,
          sessionId: trk.id,
          cwd: trk.cwd,
          role: trk.role,
          startedAt: trk.startedAt,
          status: nextStatus,
        });
        trk.inOffice = true;
        trk.lastStatus = nextStatus;
      } else if (trk.lastStatus !== nextStatus) {
        this.opts.office.setStatus(trk.agentId, nextStatus);
        trk.lastStatus = nextStatus;
      }
    } else if (trk.parentConvId) {
      const parent = this.trackers.get(trk.parentConvId);
      if (!parent || !parent.inOffice) return;

      // Subagente: aparece no escritório quando está trabalhando OU se concluiu nos últimos 15 min
      // (para a equipe toda da sprint ficar visível e depois entregar o pacote quando concluir ao vivo).
      const recentlyFinished = now - trk.lastMtimeMs <= 15 * 60_000;
      if (!trk.inOffice && (isWorking || recentlyFinished)) {
        const added = this.opts.office.addSub({
          id: trk.agentId,
          parentId: parent.agentId,
          sessionId: trk.id,
          role: trk.role,
          title: trk.title ?? trk.role,
          background: true,
          startedAt: trk.startedAt,
        });
        if (!added) return;
        trk.inOffice = true;
        trk.lastStatus = 'working';
      }

      if (trk.inOffice) {
        if (isWorking) {
          if (trk.subDone) {
            this.opts.office.reactivateSub(trk.agentId);
            trk.subDone = false;
            trk.lastStatus = 'working';
          }
        } else if (!isBoot && !trk.subDone && trk.hasFinalReply && now - trk.lastMtimeMs > 12_000) {
          // Concluiu ao vivo: anima entrega para o Tech Lead!
          this.opts.office.completeSub(trk.agentId, { notify: true });
          trk.subDone = true;
          trk.lastStatus = 'done';
        }
      }
    }

    if (!trk.inOffice) return;

    this.opts.office.applyTranscript(trk.agentId, {
      title: trk.title,
      tasks: trk.tasks,
      stats: trk.stats,
      model: trk.model,
      firstAt: trk.startedAt,
      lastAt: trk.lastEventAt,
    });

    const recentSlice = newActivities.slice(-15);
    for (let i = 0; i < recentSlice.length; i++) {
      const isLast = i === recentSlice.length - 1;
      this.opts.office.addActivity(trk.agentId, recentSlice[i], isLast, { feed: !isBoot });
    }
  }
}
