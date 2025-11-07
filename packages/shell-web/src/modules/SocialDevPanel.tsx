import { useCallback, useMemo, useState, type JSX } from 'react';

import {
  SOCIAL_COMMAND_TYPES,
  type SocialCommandPayloads,
  type SocialCommandType,
} from './worker-bridge.js';
import {
  useShellBridge,
  useShellState,
} from './ShellStateProvider.js';

function formatResult(value: unknown): string {
  if (value === undefined) {
    return 'No response payload';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `Unserializable result: ${String(error)}`;
  }
}

export function SocialDevPanel(): JSX.Element {
  const bridge = useShellBridge();
  const { social } = useShellState();
  const [accessToken, setAccessToken] = useState('');
  const [leaderboardId, setLeaderboardId] = useState('daily');
  const [score, setScore] = useState('0');
  const [guildName, setGuildName] = useState('');
  const [guildDescription, setGuildDescription] = useState('');
  const [output, setOutput] = useState<string | null>(null);

  const scoreValue = useMemo(() => Number(score), [score]);
  const isPending = social.pendingRequests.size > 0;

  const runSocialCommand = useCallback(
    async <TCommand extends SocialCommandType>(
      kind: TCommand,
      payload: Omit<SocialCommandPayloads[TCommand], 'accessToken'>,
    ) => {
      if (!accessToken.trim()) {
        setOutput('Access token is required for social commands.');
        return;
      }

      setOutput(null);
      try {
        await bridge.awaitReady();
        const result = await bridge.sendSocialCommand(kind, {
          ...payload,
          accessToken: accessToken.trim(),
        } as SocialCommandPayloads[TCommand]);
        setOutput(formatResult(result));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const details =
          error &&
          typeof error === 'object' &&
          'details' in error &&
          error.details
            ? `\nDetails: ${JSON.stringify(error.details)}`
            : '';
        setOutput(`Error: ${message}${details}`);
      }
    },
    [accessToken, bridge],
  );

  const handleFetchLeaderboard = useCallback(() => {
    runSocialCommand(SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD, {
      leaderboardId: leaderboardId.trim(),
    });
  }, [leaderboardId, runSocialCommand]);

  const handleSubmitScore = useCallback(() => {
    if (!Number.isFinite(scoreValue) || scoreValue < 0) {
      setOutput('Score must be a non-negative number.');
      return;
    }
    runSocialCommand(SOCIAL_COMMAND_TYPES.SUBMIT_LEADERBOARD_SCORE, {
      leaderboardId: leaderboardId.trim(),
      score: scoreValue,
    });
  }, [leaderboardId, runSocialCommand, scoreValue]);

  const handleFetchGuildProfile = useCallback(() => {
    runSocialCommand(SOCIAL_COMMAND_TYPES.FETCH_GUILD_PROFILE, {});
  }, [runSocialCommand]);

  const handleCreateGuild = useCallback(() => {
    if (!guildName.trim()) {
      setOutput('Guild name cannot be empty.');
      return;
    }
    runSocialCommand(SOCIAL_COMMAND_TYPES.CREATE_GUILD, {
      name: guildName.trim(),
      ...(guildDescription.trim()
        ? { description: guildDescription.trim() }
        : {}),
    });
  }, [guildDescription, guildName, runSocialCommand]);

  return (
    <section
      style={{
        border: '1px solid #ccc',
        borderRadius: 8,
        padding: 16,
        marginTop: 24,
        maxWidth: 640,
      }}
    >
      <h2>Social Service Dev Panel</h2>
      <p>
        Commands proxy through the runtime worker and require a valid bearer
        token issued by the social service. Paste an access token and execute a
        request to verify the worker bridge wiring.
      </p>

      <label style={{ display: 'block', marginBottom: 12 }}>
        Access Token
        <textarea
          value={accessToken}
          onChange={(event) => setAccessToken(event.target.value)}
          rows={3}
          style={{ width: '100%', marginTop: 4 }}
          placeholder="Bearer token copied from Keycloak or the stub auth provider"
        />
      </label>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 200px' }}>
          Leaderboard Id
          <input
            type="text"
            value={leaderboardId}
            onChange={(event) => setLeaderboardId(event.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>

        <label style={{ flex: '1 1 200px' }}>
          Score
          <input
            type="number"
            min="0"
            step="1"
            value={score}
            onChange={(event) => setScore(event.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ flex: '1 1 200px' }}>
          Guild Name
          <input
            type="text"
            value={guildName}
            onChange={(event) => setGuildName(event.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ flex: '1 1 200px' }}>
          Guild Description
          <input
            type="text"
            value={guildDescription}
            onChange={(event) => setGuildDescription(event.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 16,
        }}
      >
        <button
          type="button"
          onClick={handleFetchLeaderboard}
          disabled={isPending}
        >
          Fetch Leaderboard
        </button>
        <button
          type="button"
          onClick={handleSubmitScore}
          disabled={isPending}
        >
          Submit Score
        </button>
        <button
          type="button"
          onClick={handleFetchGuildProfile}
          disabled={isPending}
        >
          Fetch My Guild
        </button>
        <button
          type="button"
          onClick={handleCreateGuild}
          disabled={isPending}
        >
          Create Guild
        </button>
      </div>

      {output && (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: '#f5f5f5',
            borderRadius: 6,
            maxHeight: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {output}
        </pre>
      )}
    </section>
  );
}
