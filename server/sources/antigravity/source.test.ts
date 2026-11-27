import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { AntigravitySource, createAntigravityTerminalParser } from './source';

describe('AntigravitySource', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('detecta conversa principal, subagente, atividades, tarefas, tokens e terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-agy-'));
    dirs.push(root);
    const brain = join(root, 'brain');
    const mainId = '11111111-1111-4111-8111-111111111111';
    const subId = '22222222-2222-4222-8222-222222222222';
    const mainLogs = join(brain, mainId, '.system_generated', 'logs');
    const subLogs = join(brain, subId, '.system_generated', 'logs');
    mkdirSync(mainLogs, { recursive: true });
    mkdirSync(subLogs, { recursive: true });

    const now = Date.now();
    const iso = new Date(now - 2_000).toISOString();

    const mainLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER',
        type: 'USER_INPUT',
        created_at: iso,
        content: '<USER_REQUEST>Criar app mobile Expo</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: iso,
        model: 'gemini-4-neon-high',
        input_tokens: 1200,
        cache_read_tokens: 300,
        output_tokens: 250,
        tool_calls: [
          {
            name: 'update_steps',
            args: {
              steps: [
                { title: 'Setup Expo', status: 'done' },
                { title: 'Criar telas', status: 'in_progress' },
              ],
            },
          },
          {
            name: 'invoke_subagent',
            args: {
              Role: '"Lucas Mendes - Setup"',
              TypeName: '"setup-architect"',
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: iso,
        content: `Created subagent: {"conversationId": "${subId}"}\nPath: C:\\Users\\Test\\.gemini\\antigravity\\scratch\\primeiro-app-mobile`,
      }),
    ];
    writeFileSync(join(mainLogs, 'transcript.jsonl'), mainLines.join('\n') + '\n', 'utf8');

    const subLines = [
      JSON.stringify({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: iso,
        model: 'gemini-4-neon-high',
        input_tokens: 500,
        output_tokens: 100,
        tool_calls: [
          {
            name: 'write_file',
            args: {
              Path: '"C:\\Users\\Test\\.gemini\\antigravity\\scratch\\primeiro-app-mobile\\App.js"',
            },
          },
        ],
      }),
    ];
    writeFileSync(join(subLogs, 'transcript.jsonl'), subLines.join('\n') + '\n', 'utf8');

    const names = new NameStore(join(root, 'names.json'));
    const accounts = new AccountsService({ dirs: [], home: root, env: {}, onChange: () => {} });
    const office = new Office({
      names,
      version: '1.0.3',
      startedAt: now,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: (id) => accounts.find(id)?.detected.name,
      now: () => now,
    });

    const source = new AntigravitySource({ accounts, office, brainDir: brain, pollMs: 60_000, now: () => now });
    source.start();
    try {
      const agents = office.list();
      expect(agents).toHaveLength(2);
      const main = agents.find((a) => a.kind === 'main');
      const sub = agents.find((a) => a.kind === 'sub');
      expect(main).toBeDefined();
      expect(sub).toBeDefined();
      expect(main!.account).toBe('.antigravity');
      expect(main!.status).toBe('working');
      expect(main!.stats.tokensIn).toBe(1500);
      expect(main!.stats.tokensOut).toBe(250);
      expect(main!.tasks).toHaveLength(2);
      expect(main!.tasks[0].status).toBe('completed');
      expect(sub!.parentId).toBe(main!.id);
      expect(sub!.role).toBe('Lucas Mendes - Setup');
      expect(sub!.activity?.kind).toBe('write');
      expect(source.sources()[0].ok).toBe(true);
      expect(source.sources()[0].sessions).toBe(2);

      // Parser de terminal
      const parser = createAntigravityTerminalParser();
      const parsed = mainLines.flatMap((l) => parser.push(l));
      expect(parsed.some((e) => e.kind === 'user')).toBe(true);
      expect(parsed.some((e) => e.kind === 'tool' && e.tool === 'invoke_subagent')).toBe(true);
    } finally {
      source.stop();
    }
  });
});
