import { describe, it, expect } from 'vitest';
import { assertCrudRegistryInvariants, CRUD_REGISTRY, CRUD_RESOURCES } from './crud.registry.js';

describe('CRUD registry invariants', () => {
  it('passes boot-time validation', () => {
    expect(() => assertCrudRegistryInvariants()).not.toThrow();
  });

  it('exposes each resource exactly once', () => {
    expect(new Set(CRUD_RESOURCES).size).toBe(CRUD_RESOURCES.length);
  });

  it('every required field is writable', () => {
    for (const def of CRUD_REGISTRY) {
      for (const [name, field] of Object.entries(def.fields)) {
        expect(field.required ? field.writable : true, `${def.resource}.${name}`).toBe(true);
      }
    }
  });

  it('every enum field declares values', () => {
    for (const def of CRUD_REGISTRY) {
      for (const [name, field] of Object.entries(def.fields)) {
        if (field.kind === 'enum') {
          expect(field.enumValues?.length ?? 0, `${def.resource}.${name}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never registers the sensitive/money/identity tables', () => {
    const models = CRUD_REGISTRY.map((def) => def.modelName);
    expect(models).not.toContain('Profile');
    expect(models).not.toContain('Account');
    expect(models).not.toContain('Wallet');
    expect(models).not.toContain('Card');
    expect(models).not.toContain('Transaction');
    expect(models).not.toContain('TransactionApproval');
    expect(models).not.toContain('OtpCode');
  });

  it('card-providers hides config entirely (not writable, never visible)', () => {
    const provider = CRUD_REGISTRY.find((def) => def.resource === 'card-providers');
    expect(provider).toBeDefined();
    expect(provider?.fields.config).toBeUndefined();
    expect(provider?.fields).not.toHaveProperty('config');
  });

  it('card-providers exposes the safe columns only', () => {
    const provider = CRUD_REGISTRY.find((def) => def.resource === 'card-providers')!;
    expect(Object.keys(provider.fields).sort()).toEqual(
      ['baseUrl', 'createdAt', 'id', 'isActive', 'name', 'updatedAt'].sort(),
    );
    // name/baseUrl/isActive are freely writable; id + timestamps are server-managed.
    for (const field of ['name', 'baseUrl', 'isActive']) {
      expect(provider.fields[field].writable).toBe(true);
      expect(provider.fields[field].visible).toBe(true);
    }
    expect(provider.fields.id.writable).toBe(false);
    expect(provider.fields.createdAt.writable).toBe(false);
  });

  it('audit-logs is read-only', () => {
    const audit = CRUD_REGISTRY.find((def) => def.resource === 'audit-logs')!;
    expect(audit.methods).toEqual(['list', 'get']);
    for (const field of Object.values(audit.fields)) {
      expect(field.writable, `audit-logs.${field}`).toBe(false);
    }
  });

  it('every model exposes at least one visible field', () => {
    for (const def of CRUD_REGISTRY) {
      const visibleCount = Object.values(def.fields).filter((field) => field.visible).length;
      expect(visibleCount, def.resource).toBeGreaterThan(0);
    }
  });

  it('registers exactly the nine safe resources', () => {
    expect(CRUD_REGISTRY).toHaveLength(9);
    expect(CRUD_RESOURCES).toEqual(
      expect.arrayContaining([
        'card-locks',
        'card-categories',
        'chats',
        'messages',
        'transaction-thresholds',
        'biometric-devices',
        'notifications',
        'card-providers',
        'audit-logs',
      ]),
    );
  });
});
