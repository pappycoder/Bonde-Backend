import type { Prisma } from '@prisma/client';

/**
 * Field kind drives payload coercion/validation in `CrudService`.
 */
export type CrudFieldKind =
  'uuid' | 'string' | 'int' | 'decimal' | 'boolean' | 'enum' | 'json' | 'datetime';

export interface CrudModelField {
  kind: CrudFieldKind;
  /** Mandatory on create (POST). */
  required: boolean;
  /** Settable via POST/PATCH. Server-managed fields (id, timestamps) are false. */
  writable: boolean;
  /** Returned by GET. False only for sensitive fields (e.g. provider `config`). */
  visible: boolean;
  /** Closed set for `enum` kind. */
  enumValues?: readonly string[];
}

export type CrudMethod = 'create' | 'list' | 'get' | 'update' | 'delete';

export interface CrudModelDef {
  /** Prisma model name. */
  modelName: Prisma.ModelName;
  /** URL path segment for this resource. */
  resource: string;
  /** Human label (docs/messages). */
  label: string;
  /** Allowed verbs. `audit-logs` is read-only (`list`,`get`). */
  methods: CrudMethod[];
  /** Visible string fields searched by the free-text `q` query param. */
  searchable: readonly string[];
  fields: Record<string, CrudModelField>;
}

// ---------------------------------------------------------------------------
// Field builders keep the per-model definitions readable.
// ---------------------------------------------------------------------------

const idField = (): CrudModelField => ({
  kind: 'uuid',
  required: false,
  writable: false,
  visible: true,
});
const timestampField = (): CrudModelField => ({
  kind: 'datetime',
  required: false,
  writable: false,
  visible: true,
});
/** Server-managed field that is informational only (e.g. `readAt`). */
const serverField = (kind: CrudFieldKind): CrudModelField => ({
  kind,
  required: false,
  writable: false,
  visible: true,
});
const f = (kind: CrudFieldKind, opts: Partial<CrudModelField> = {}): CrudModelField => ({
  kind,
  required: false,
  writable: true,
  visible: true,
  ...opts,
});

/**
 * The SAFE subset of tables exposed to the generic admin data-grid.
 *
 * Intentionally NOT here (dedicated, business-rule endpoints only): profiles,
 * accounts, wallets (balance integrity), cards (PAN), transactions /
 * transaction_approvals (money movement + workflow), otp_codes (hashes).
 * `card-providers.config` holds API secrets — never writable, never returned.
 * `audit-logs` is append-only: read/query only.
 */
export const CRUD_REGISTRY: readonly CrudModelDef[] = [
  {
    modelName: 'CardLock',
    resource: 'card-locks',
    label: 'Card lock',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: [],
    fields: {
      id: idField(),
      cardId: f('uuid', { required: true }),
      lockType: f('enum', {
        required: true,
        enumValues: ['SELF_DESTRUCT', 'MERCHANT', 'TIME', 'CATEGORY', 'BUDGET'],
      }),
      config: f('json'),
      isActive: f('boolean'),
      createdAt: timestampField(),
    },
  },
  {
    modelName: 'CardCategory',
    resource: 'card-categories',
    label: 'Card restricted category',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: [],
    fields: {
      id: idField(),
      cardId: f('uuid', { required: true }),
      category: f('enum', { required: true, enumValues: ['TRAVEL_HOTEL', 'FOOD_RESTAURANT'] }),
      isAllowed: f('boolean'),
      createdAt: timestampField(),
    },
  },
  {
    modelName: 'Chat',
    resource: 'chats',
    label: 'AI chat session',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: ['title'],
    fields: {
      id: idField(),
      userId: f('uuid', { required: true }),
      title: f('string'),
      createdAt: timestampField(),
      updatedAt: timestampField(),
    },
  },
  {
    modelName: 'Message',
    resource: 'messages',
    label: 'Chat message',
    methods: ['create', 'list', 'get', 'delete'],
    searchable: ['content'],
    fields: {
      id: idField(),
      chatId: f('uuid', { required: true }),
      role: f('enum', { required: true, enumValues: ['USER', 'ASSISTANT', 'SYSTEM'] }),
      content: f('string', { required: true }),
      createdAt: timestampField(),
    },
  },
  {
    modelName: 'TransactionThreshold',
    resource: 'transaction-thresholds',
    label: 'Transaction threshold',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: [],
    fields: {
      id: idField(),
      userId: f('uuid', { required: true }),
      thresholdType: f('enum', { required: true, enumValues: ['FIRST_TIME', 'LARGE_AMOUNT'] }),
      thresholdValue: f('decimal', { required: true }),
      isActive: f('boolean'),
      createdAt: timestampField(),
      updatedAt: timestampField(),
    },
  },
  {
    modelName: 'BiometricDevice',
    resource: 'biometric-devices',
    label: 'Biometric device',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: ['deviceId', 'deviceName'],
    fields: {
      id: idField(),
      userId: f('uuid', { required: true }),
      deviceId: f('string', { required: true }),
      deviceName: f('string', { required: true }),
      biometricType: f('enum', { required: true, enumValues: ['FACE', 'FINGERPRINT'] }),
      publicKey: f('string', { required: true }),
      isActive: f('boolean'),
      lastUsedAt: serverField('datetime'),
      createdAt: timestampField(),
      updatedAt: timestampField(),
    },
  },
  {
    modelName: 'Notification',
    resource: 'notifications',
    label: 'Notification',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: ['title', 'content'],
    fields: {
      id: idField(),
      userId: f('uuid', { required: true }),
      title: f('string', { required: true }),
      content: f('string', { required: true }),
      status: f('enum', { enumValues: ['UNREAD', 'READ'] }),
      type: f('enum', { enumValues: ['SYSTEM', 'TRANSACTION', 'CHAT', 'CARD'] }),
      metadata: f('json'),
      readAt: serverField('datetime'),
      createdAt: timestampField(),
    },
  },
  {
    modelName: 'CardProvider',
    resource: 'card-providers',
    label: 'Card provider',
    methods: ['create', 'list', 'get', 'update', 'delete'],
    searchable: ['name', 'baseUrl'],
    fields: {
      id: idField(),
      name: f('string', { required: true }),
      baseUrl: f('string', { required: true }),
      isActive: f('boolean'),
      // `config` holds API keys/secrets — deliberately absent from this table.
      createdAt: timestampField(),
      updatedAt: timestampField(),
    },
  },
  {
    modelName: 'AuditLog',
    resource: 'audit-logs',
    label: 'Audit log',
    methods: ['list', 'get'],
    searchable: ['action', 'entityType'],
    fields: {
      id: idField(),
      userId: serverField('uuid'),
      action: serverField('string'),
      entityType: serverField('string'),
      entityId: serverField('uuid'),
      metadata: serverField('json'),
      ipAddress: serverField('string'),
      userAgent: serverField('string'),
      createdAt: timestampField(),
    },
  },
];

export const CRUD_RESOURCES: readonly string[] = CRUD_REGISTRY.map((def) => def.resource);
export const CRUD_BY_RESOURCE: ReadonlyMap<string, CrudModelDef> = new Map(
  CRUD_REGISTRY.map((def) => [def.resource, def]),
);

/**
 * Boot-time invariant check — every registration must be self-consistent.
 * Throws (fail-fast) if a future edit diverges from the schema contract.
 */
export function assertCrudRegistryInvariants(): void {
  const seenResources = new Set<string>();
  const seenModels = new Set<string>();
  for (const def of CRUD_REGISTRY) {
    if (seenResources.has(def.resource)) {
      throw new Error(`CRUD registry: duplicate resource "${def.resource}"`);
    }
    seenResources.add(def.resource);
    if (seenModels.has(def.modelName)) {
      throw new Error(`CRUD registry: duplicate model "${def.modelName}"`);
    }
    seenModels.add(def.modelName);
    if (def.methods.length === 0) {
      throw new Error(`CRUD registry: "${def.resource}" declares no methods`);
    }
    for (const name of def.searchable) {
      const field = def.fields[name];
      if (!field) {
        throw new Error(
          `CRUD registry: "${def.resource}.searchable" references unknown field "${name}"`,
        );
      }
      if (field.kind !== 'string' || !field.visible) {
        throw new Error(
          `CRUD registry: "${def.resource}.searchable" field "${name}" must be a visible string field`,
        );
      }
    }
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.required && !field.writable) {
        throw new Error(`CRUD registry: "${def.resource}.${name}" is required but not writable`);
      }
      if (field.kind === 'enum' && (!field.enumValues || field.enumValues.length === 0)) {
        throw new Error(`CRUD registry: "${def.resource}.${name}" enum has no values`);
      }
    }
  }
}
