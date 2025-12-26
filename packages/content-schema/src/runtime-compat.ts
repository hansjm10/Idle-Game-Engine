import semver from 'semver';

export const FEATURE_GATES = [
  {
    module: 'automations',
    introducedIn: '0.2.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
  {
    module: 'transforms',
    introducedIn: '0.3.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
  {
    module: 'runtimeEvents',
    introducedIn: '0.3.0',
    docRef: 'docs/runtime-event-pubsub-design.md',
  },
  {
    module: 'prestigeLayers',
    introducedIn: '0.4.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
] as const;

export type FeatureGateModule = (typeof FEATURE_GATES)[number]['module'];

export type FeatureGateMap = Readonly<Record<FeatureGateModule, boolean>>;

export interface FeatureViolation {
  readonly module: FeatureGateModule;
  readonly requiredVersion: string;
  readonly docRef: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

const normalizeRuntimeVersion = (runtimeVersion: string | undefined): string | null => {
  if (!runtimeVersion) {
    return null;
  }
  const exactVersion = semver.valid(runtimeVersion);
  if (exactVersion) {
    return exactVersion;
  }

  const cleanedVersion = semver.clean(runtimeVersion);
  if (cleanedVersion) {
    return cleanedVersion;
  }

  const normalized = semver.coerce(runtimeVersion);
  return normalized ? normalized.version : null;
};

export const resolveFeatureViolations = (
  runtimeVersion: string | undefined,
  context: FeatureGateMap,
): readonly FeatureViolation[] => {
  const normalizedRuntimeVersion = normalizeRuntimeVersion(runtimeVersion);
  const violations: FeatureViolation[] = [];

  FEATURE_GATES.forEach((gate) => {
    if (!context[gate.module]) {
      return;
    }

    const messageBase = `Module "${gate.module}" requires runtime version ${gate.introducedIn} or later (${gate.docRef}).`;

    if (!normalizedRuntimeVersion) {
      violations.push({
        module: gate.module,
        requiredVersion: gate.introducedIn,
        docRef: gate.docRef,
        severity: 'warning',
        message: `${messageBase} Provide ContentSchemaOptions.runtimeVersion to enforce compatibility.`,
      });
      return;
    }

    if (semver.lt(normalizedRuntimeVersion, gate.introducedIn)) {
      violations.push({
        module: gate.module,
        requiredVersion: gate.introducedIn,
        docRef: gate.docRef,
        severity: 'error',
        message: `${messageBase} Current runtime version ${normalizedRuntimeVersion} is too old.`,
      });
    }
  });

  return violations;
};
