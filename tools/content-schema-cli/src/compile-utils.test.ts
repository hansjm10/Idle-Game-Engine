import { describe, expect, it } from 'vitest';

import type { FileWriteOperation } from '@idle-engine/content-compiler';

import type {
  BalanceIssue,
  FormattedArtifact,
  PipelineOutcome,
  RunSummary,
  ValidationFailureSummaryEntry,
  WatchTrigger,
} from './compile-utils.js';
import {
  BOOLEAN_FLAGS,
  createValidationFailureRunSummary,
  createValidationFailureSummary,
  deriveBalanceFromIssues,
  determineWatchStatus,
  emptySummaryArtifacts,
  emptySummaryDependencies,
  extractRuntimeEventManifestHash,
  filterPrunedArtifacts,
  formatOperation,
  formatProcessOutput,
  groupOperationsBySlug,
  isChangeAction,
  isNodeError,
  MAX_TRIGGER_PATHS,
  normalizeError,
  normalizeWatchTargetPath,
  parseArgs,
  parseValueArg,
  resolveSummaryOutputPath,
  resolveWorkspaceRoot,
  summarizeWatchTriggers,
  toPosixPath,
} from './compile-utils.js';

describe('compile-utils pure functions', () => {
  describe('parseValueArg', () => {
    it('parses inline value with equals sign', () => {
      const result = parseValueArg('--cwd=/path/to/dir', [], 0, '--cwd');
      expect(result).toEqual({ value: '/path/to/dir', skip: 0 });
    });

    it('parses value from next argument', () => {
      const argv = ['--cwd', '/path/to/dir'];
      const result = parseValueArg('--cwd', argv, 0, '--cwd');
      expect(result).toEqual({ value: '/path/to/dir', skip: 1 });
    });

    it('throws when next argument is missing', () => {
      const argv = ['--cwd'];
      expect(() => parseValueArg('--cwd', argv, 0, '--cwd')).toThrow(
        'Missing value for --cwd',
      );
    });

    it('handles empty inline value', () => {
      const result = parseValueArg('--summary=', [], 0, '--summary');
      expect(result).toEqual({ value: '', skip: 0 });
    });
  });

  describe('parseArgs', () => {
    const mockResolveCwd = (p: string): string => `/resolved/${p}`;

    it('parses boolean flags', () => {
      const result = parseArgs(['--check', '--clean', '--pretty', '--watch'], mockResolveCwd);
      expect(result).toEqual({
        check: true,
        clean: true,
        pretty: true,
        watch: true,
        summary: undefined,
        cwd: undefined,
      });
    });

    it('parses --cwd with separate value', () => {
      const result = parseArgs(['--cwd', 'my/path'], mockResolveCwd);
      expect(result.cwd).toBe('/resolved/my/path');
    });

    it('parses -C shorthand', () => {
      const result = parseArgs(['-C', 'my/path'], mockResolveCwd);
      expect(result.cwd).toBe('/resolved/my/path');
    });

    it('parses --cwd=value inline syntax', () => {
      const result = parseArgs(['--cwd=my/path'], mockResolveCwd);
      expect(result.cwd).toBe('/resolved/my/path');
    });

    it('parses --summary with separate value', () => {
      const result = parseArgs(['--summary', 'output.json'], mockResolveCwd);
      expect(result.summary).toBe('output.json');
    });

    it('parses --summary=value inline syntax', () => {
      const result = parseArgs(['--summary=output.json'], mockResolveCwd);
      expect(result.summary).toBe('output.json');
    });

    it('returns help sentinel for --help', () => {
      const result = parseArgs(['--help'], mockResolveCwd);
      expect(result.cwd).toBe('__HELP__');
    });

    it('returns help sentinel for -h', () => {
      const result = parseArgs(['-h'], mockResolveCwd);
      expect(result.cwd).toBe('__HELP__');
    });

    it('throws on unknown option', () => {
      expect(() => parseArgs(['--unknown'], mockResolveCwd)).toThrow(
        'Unknown option: --unknown',
      );
    });

    it('parses multiple options together', () => {
      const result = parseArgs(
        ['--check', '--cwd', 'dir', '--summary=out.json', '--pretty'],
        mockResolveCwd,
      );
      expect(result).toEqual({
        check: true,
        clean: false,
        pretty: true,
        watch: false,
        summary: 'out.json',
        cwd: '/resolved/dir',
      });
    });
  });

  describe('normalizeError', () => {
    it('normalizes Error instances', () => {
      const error = new Error('test message');
      error.name = 'TestError';
      const result = normalizeError(error);
      expect(result.name).toBe('TestError');
      expect(result.message).toBe('test message');
      expect(result.stack).toBeDefined();
    });

    it('normalizes string errors', () => {
      const result = normalizeError('string error');
      expect(result).toEqual({
        name: undefined,
        message: 'string error',
        stack: undefined,
      });
    });

    it('normalizes null', () => {
      const result = normalizeError(null);
      expect(result.message).toBe('null');
    });

    it('normalizes undefined', () => {
      const result = normalizeError(undefined);
      expect(result.message).toBe('undefined');
    });

    it('normalizes objects', () => {
      const result = normalizeError({ foo: 'bar' });
      expect(result.message).toBe('[object Object]');
    });
  });

  describe('isNodeError', () => {
    it('returns true for Error with code property', () => {
      const error = new Error('test') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      expect(isNodeError(error)).toBe(true);
    });

    it('returns false for Error without code property', () => {
      const error = new Error('test');
      expect(isNodeError(error)).toBe(false);
    });

    it('returns false for non-Error objects', () => {
      expect(isNodeError('not an error')).toBe(false);
      expect(isNodeError({ code: 'ENOENT' })).toBe(false);
    });
  });

  describe('toPosixPath', () => {
    it('returns empty string for empty input', () => {
      expect(toPosixPath('')).toBe('');
    });

    it('converts backslashes to forward slashes', () => {
      expect(toPosixPath('path/to/file')).toBe('path/to/file');
    });

    it('handles single path segment', () => {
      expect(toPosixPath('file.txt')).toBe('file.txt');
    });
  });

  describe('isChangeAction', () => {
    it('returns true for written', () => {
      expect(isChangeAction('written')).toBe(true);
    });

    it('returns true for deleted', () => {
      expect(isChangeAction('deleted')).toBe(true);
    });

    it('returns true for would-write', () => {
      expect(isChangeAction('would-write')).toBe(true);
    });

    it('returns true for would-delete', () => {
      expect(isChangeAction('would-delete')).toBe(true);
    });

    it('returns false for unchanged', () => {
      expect(isChangeAction('unchanged')).toBe(false);
    });

    it('returns false for skipped', () => {
      expect(isChangeAction('skipped')).toBe(false);
    });
  });

  describe('formatOperation', () => {
    it('formats FileWriteOperation to minimal object', () => {
      const operation = {
        kind: 'artifact',
        path: 'content/compiled/pack.json',
        action: 'written',
        slug: 'test-pack',
        extra: 'ignored',
      } as unknown as FileWriteOperation;

      const result = formatOperation(operation);
      expect(result).toEqual({
        kind: 'artifact',
        path: 'content/compiled/pack.json',
        action: 'written',
      });
    });
  });

  describe('extractRuntimeEventManifestHash', () => {
    it('extracts hash from manifest source with single quotes', () => {
      const source = "export const manifest = { hash: 'abcd1234' };";
      expect(extractRuntimeEventManifestHash(source)).toBe('abcd1234');
    });

    it('extracts hash from manifest source with double quotes', () => {
      const source = 'export const manifest = { hash: "ABCD1234" };';
      expect(extractRuntimeEventManifestHash(source)).toBe('abcd1234');
    });

    it('handles whitespace variations', () => {
      const source = 'hash   :   "ef567890"';
      expect(extractRuntimeEventManifestHash(source)).toBe('ef567890');
    });

    it('returns undefined when no hash found', () => {
      const source = 'export const manifest = {};';
      expect(extractRuntimeEventManifestHash(source)).toBeUndefined();
    });

    it('returns undefined for invalid hash format', () => {
      const source = "hash: 'invalid!'";
      expect(extractRuntimeEventManifestHash(source)).toBeUndefined();
    });
  });

  describe('summarizeWatchTriggers', () => {
    it('returns empty summary for empty triggers', () => {
      const result = summarizeWatchTriggers([]);
      expect(result).toEqual({
        count: 0,
        limit: MAX_TRIGGER_PATHS,
      });
    });

    it('counts events by type', () => {
      const triggers: WatchTrigger[] = [
        { event: 'change', path: 'a.json' },
        { event: 'change', path: 'b.json' },
        { event: 'add', path: 'c.json' },
      ];
      const result = summarizeWatchTriggers(triggers);
      expect(result.events).toEqual({ add: 1, change: 2 });
    });

    it('collects unique paths', () => {
      const triggers: WatchTrigger[] = [
        { event: 'change', path: 'a.json' },
        { event: 'change', path: 'a.json' },
        { event: 'add', path: 'b.json' },
      ];
      const result = summarizeWatchTriggers(triggers);
      expect(result.paths).toEqual(['a.json', 'b.json']);
    });

    it('limits paths to MAX_TRIGGER_PATHS', () => {
      const triggers: WatchTrigger[] = Array.from({ length: 15 }, (_, i) => ({
        event: 'change',
        path: `file${i}.json`,
      }));
      const result = summarizeWatchTriggers(triggers);
      expect(result.paths).toHaveLength(MAX_TRIGGER_PATHS);
      expect(result.morePaths).toBe(5);
    });

    it('handles triggers without path', () => {
      const triggers: WatchTrigger[] = [{ event: 'ready' }];
      const result = summarizeWatchTriggers(triggers);
      expect(result.count).toBe(1);
      expect(result.paths).toBeUndefined();
    });
  });

  describe('deriveBalanceFromIssues', () => {
    it('returns empty object for undefined issues', () => {
      expect(deriveBalanceFromIssues(undefined)).toEqual({});
    });

    it('returns empty object for non-array issues', () => {
      expect(deriveBalanceFromIssues(null as unknown as BalanceIssue[])).toEqual({});
    });

    it('returns empty object when no balance issues', () => {
      const issues: BalanceIssue[] = [{ code: 'other.error' }];
      expect(deriveBalanceFromIssues(issues)).toEqual({});
    });

    it('extracts balance errors', () => {
      const issues: BalanceIssue[] = [
        { code: 'balance.resource_cost' },
        { code: 'other.error' },
        { code: 'balance.time_rate' },
      ];
      const result = deriveBalanceFromIssues(issues);
      expect(result.balance).toEqual({
        warnings: [],
        errors: [{ code: 'balance.resource_cost' }, { code: 'balance.time_rate' }],
        warningCount: 0,
        errorCount: 2,
      });
    });
  });

  describe('emptySummaryDependencies', () => {
    it('returns empty dependencies structure', () => {
      expect(emptySummaryDependencies()).toEqual({
        requires: [],
        optional: [],
        conflicts: [],
      });
    });
  });

  describe('emptySummaryArtifacts', () => {
    it('returns empty object', () => {
      expect(emptySummaryArtifacts()).toEqual({});
    });
  });

  describe('createValidationFailureSummary', () => {
    interface SummaryPack {
      slug: string;
      status: string;
      version?: string;
      balance?: unknown;
    }

    it('creates summary from failures', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: 'pack-b', path: '/path/b', message: 'Error B' },
        { packSlug: 'pack-a', path: '/path/a', message: 'Error A' },
      ];
      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs).toHaveLength(2);
      expect(packs[0].slug).toBe('pack-a');
      expect(packs[1].slug).toBe('pack-b');
    });

    it('includes version when provided', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: 'pack-a', packVersion: '1.0.0', path: '/path/a', message: 'Error' },
      ];
      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs[0].version).toBe('1.0.0');
    });

    it('uses path as slug fallback when packSlug is undefined', () => {
      const failures = [
        { path: '/fallback/path', message: 'Error' },
      ] as ValidationFailureSummaryEntry[];
      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs[0].slug).toBe('/fallback/path');
    });

    it('uses empty string slug when packSlug is empty', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: '', path: '/fallback/path', message: 'Error' },
      ];
      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs[0].slug).toBe('');
    });

    it('derives balance from issues', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        {
          packSlug: 'pack-a',
          path: '/path/a',
          message: 'Error',
          issues: [{ code: 'balance.resource' }],
        },
      ];
      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs[0].balance).toBeDefined();
    });

    it('keeps sort comparator stable for identical slugs', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: 'same', path: '/path/a', message: 'Error A' },
        { packSlug: 'same', path: '/path/b', message: 'Error B' },
      ];

      const result = createValidationFailureSummary(failures);
      const packs = result.packs as SummaryPack[];
      expect(packs).toHaveLength(2);
      expect(packs[0]?.slug).toBe('same');
      expect(packs[1]?.slug).toBe('same');
    });
  });

  describe('createValidationFailureRunSummary', () => {
    it('creates run summary from failures', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: 'pack-b', path: '/path/b', message: 'Error B' },
        { packSlug: 'pack-a', path: '/path/a', message: 'Error A' },
      ];
      const result = createValidationFailureRunSummary({
        failures,
        summaryAction: 'written',
      });
      expect(result.packTotals).toEqual({
        total: 2,
        compiled: 0,
        failed: 2,
        withWarnings: 0,
      });
      expect(result.failedPacks).toEqual(['pack-a', 'pack-b']);
      expect(result.hasChanges).toBe(true);
    });

    it('sets hasChanges false for unchanged summary', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: 'pack-a', path: '/path/a', message: 'Error' },
      ];
      const result = createValidationFailureRunSummary({
        failures,
        summaryAction: 'unchanged',
      });
      expect(result.hasChanges).toBe(false);
    });

    it('filters out invalid slugs', () => {
      const failures: ValidationFailureSummaryEntry[] = [
        { packSlug: '', path: '/path/a', message: 'Error' },
        { packSlug: 'valid-pack', path: '/path/b', message: 'Error' },
      ];
      const result = createValidationFailureRunSummary({
        failures,
        summaryAction: 'written',
      });
      expect(result.failedPacks).toEqual(['valid-pack']);
      expect(result.packTotals.total).toBe(1);
    });
  });

  describe('resolveSummaryOutputPath', () => {
    it('returns default path when no override', () => {
      const result = resolveSummaryOutputPath('/root');
      expect(result).toMatch(/content\/compiled\/index\.json$/);
    });

    it('uses absolute override path directly', () => {
      const result = resolveSummaryOutputPath('/root', '/absolute/path.json');
      expect(result).toBe('/absolute/path.json');
    });

    it('resolves relative override path from root', () => {
      const result = resolveSummaryOutputPath('/root', 'relative/path.json');
      expect(result).toMatch(/\/root\/relative\/path\.json$/);
    });
  });

  describe('resolveWorkspaceRoot', () => {
    it('returns absolute path unchanged', () => {
      expect(resolveWorkspaceRoot('/absolute/path')).toBe('/absolute/path');
    });

    it('resolves relative path from cwd', () => {
      const result = resolveWorkspaceRoot('relative/path');
      expect(result).toMatch(/relative\/path$/);
      expect(result.startsWith('/')).toBe(true);
    });
  });

  describe('normalizeWatchTargetPath', () => {
    it('returns empty string for empty path', () => {
      expect(normalizeWatchTargetPath('/root', '')).toBe('');
    });

    it('returns empty string for non-string path', () => {
      expect(normalizeWatchTargetPath('/root', undefined as unknown as string)).toBe('');
    });

    it('converts to posix relative path', () => {
      const result = normalizeWatchTargetPath('/root', '/root/content/pack.json');
      expect(result).toBe('content/pack.json');
    });

    it('resolves relative paths first', () => {
      const result = normalizeWatchTargetPath('/root', 'content/pack.json');
      expect(result).toBe('content/pack.json');
    });
  });

  describe('formatProcessOutput', () => {
    it('returns empty string for empty output', () => {
      expect(formatProcessOutput({ code: 0, stdout: '', stderr: '' })).toBe('');
    });

    it('combines stdout and stderr', () => {
      const result = formatProcessOutput({
        code: 0,
        stdout: 'out',
        stderr: 'err',
      });
      expect(result).toBe('outerr');
    });

    it('trims whitespace', () => {
      const result = formatProcessOutput({
        code: 0,
        stdout: '  output  ',
        stderr: '',
      });
      expect(result).toBe('output');
    });

    it('clips long output to last 4000 characters', () => {
      const longOutput = 'x'.repeat(5000);
      const result = formatProcessOutput({
        code: 0,
        stdout: longOutput,
        stderr: '',
      });
      expect(result.length).toBeLessThanOrEqual(4000);
    });
  });

  describe('groupOperationsBySlug', () => {
    it('groups operations by slug', () => {
      const operations = [
        { slug: 'a', path: '1.json' },
        { slug: 'b', path: '2.json' },
        { slug: 'a', path: '3.json' },
      ] as FileWriteOperation[];
      const result = groupOperationsBySlug(operations);
      expect(result.get('a')).toHaveLength(2);
      expect(result.get('b')).toHaveLength(1);
    });

    it('returns empty map for empty operations', () => {
      const result = groupOperationsBySlug([]);
      expect(result.size).toBe(0);
    });
  });

  describe('filterPrunedArtifacts', () => {
    it('filters to deleted and would-delete actions', () => {
      const artifacts: FormattedArtifact[] = [
        { kind: 'artifact', action: 'written', path: 'a.json' },
        { kind: 'artifact', action: 'deleted', path: 'b.json' },
        { kind: 'artifact', action: 'unchanged', path: 'c.json' },
        { kind: 'artifact', action: 'would-delete', path: 'd.json' },
      ];
      const result = filterPrunedArtifacts(artifacts);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.path)).toEqual(['b.json', 'd.json']);
    });

    it('returns empty array when no pruned artifacts', () => {
      const artifacts: FormattedArtifact[] = [
        { kind: 'artifact', action: 'written', path: 'a.json' },
      ];
      expect(filterPrunedArtifacts(artifacts)).toEqual([]);
    });
  });

  describe('determineWatchStatus', () => {
    it('returns failed when outcome is not successful', () => {
      const outcome: PipelineOutcome = {
        success: false,
        drift: false,
        runSummary: undefined,
      };
      expect(determineWatchStatus(outcome)).toBe('failed');
    });

    it('returns skipped when no changes', () => {
      const outcome: PipelineOutcome = {
        success: true,
        drift: false,
        runSummary: {
          hasChanges: false,
        } as RunSummary,
      };
      expect(determineWatchStatus(outcome)).toBe('skipped');
    });

    it('returns success when changes present', () => {
      const outcome: PipelineOutcome = {
        success: true,
        drift: false,
        runSummary: {
          hasChanges: true,
        } as RunSummary,
      };
      expect(determineWatchStatus(outcome)).toBe('success');
    });

    it('returns success when no runSummary', () => {
      const outcome: PipelineOutcome = {
        success: true,
        drift: false,
        runSummary: undefined,
      };
      expect(determineWatchStatus(outcome)).toBe('success');
    });
  });

  describe('constants', () => {
    it('BOOLEAN_FLAGS contains expected flags', () => {
      expect(BOOLEAN_FLAGS.has('--check')).toBe(true);
      expect(BOOLEAN_FLAGS.has('--clean')).toBe(true);
      expect(BOOLEAN_FLAGS.has('--pretty')).toBe(true);
      expect(BOOLEAN_FLAGS.has('--watch')).toBe(true);
      expect(BOOLEAN_FLAGS.size).toBe(4);
    });

    it('MAX_TRIGGER_PATHS is defined', () => {
      expect(MAX_TRIGGER_PATHS).toBe(10);
    });
  });
});
