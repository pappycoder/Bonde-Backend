import {
  BadRequestException,
  ConflictException,
  Injectable,
  MethodNotAllowedException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertCrudRegistryInvariants,
  CRUD_BY_RESOURCE,
  type CrudMethod,
  type CrudModelDef,
  type CrudModelField,
} from './crud.registry.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_PATTERN = /^[+-]?[0-9]+$/;
const DECIMAL_PATTERN = /^[+-]?[0-9]+(\.[0-9]+)?$/;

export interface CrudListOptions {
  page?: number;
  pageSize?: number;
  filters?: string[] | string;
  orderBy?: string;
}

interface CrudDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }): Promise<unknown>;
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    orderBy: Record<string, string>;
    skip: number;
    take: number;
  }): Promise<unknown>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  delete(args: { where: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Generic admin data-grid over the SAFE registry tables. Every mutation is
 * validated field-by-field against the registry: required fields are enforced
 * on create, only writable fields are accepted, sensitive fields are never
 * selected into responses, enums/decimals/uuids are coerced and verified.
 */
@Injectable()
export class CrudService {
  constructor(private readonly prisma: PrismaService) {
    assertCrudRegistryInvariants();
  }

  async create(resource: string, data: Record<string, unknown>): Promise<unknown> {
    const def = this.defFor(resource, 'create');
    const payload = this.validatePayload(def, data, { forCreate: true });
    payload.id = randomUUID();
    try {
      return await this.run(def, () =>
        this.delegate(def).create({ data: payload as Record<string, unknown> }),
      );
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  async list(resource: string, options: CrudListOptions = {}): Promise<unknown> {
    const def = this.defFor(resource, 'list');
    const page =
      typeof options.page === 'number' && options.page >= 1 ? Math.floor(options.page) : 1;
    const pageSize =
      typeof options.pageSize === 'number'
        ? Math.min(Math.max(Math.floor(options.pageSize), 1), 100)
        : 20;

    const where = this.buildFilters(def, options.filters);
    const orderBy = this.buildOrderBy(def, options.orderBy ?? 'createdAt:desc');
    const select = this.select(def);
    const skip = (page - 1) * pageSize;

    try {
      const [items, total] = await Promise.all([
        this.delegate(def).findMany({ where, select, orderBy, skip, take: pageSize }),
        this.delegate(def).count({ where }),
      ]);
      const arrayItems = Array.isArray(items) ? items : [];
      return {
        items: arrayItems.map((item) => this.serialize(def, item)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  async get(resource: string, id: string): Promise<unknown> {
    const def = this.defFor(resource, 'get');
    if (!UUID_PATTERN.test(id)) throw new BadRequestException('id must be a UUID');
    try {
      const record = await this.delegate(def).findUnique({
        where: { id },
        select: this.select(def),
      });
      if (!record) throw new NotFoundException(`${def.label} not found`);
      return this.serialize(def, record);
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  async update(resource: string, id: string, data: Record<string, unknown>): Promise<unknown> {
    const def = this.defFor(resource, 'update');
    if (!UUID_PATTERN.test(id)) throw new BadRequestException('id must be a UUID');
    const payload = this.validatePayload(def, data, { forCreate: false });
    try {
      const record = await this.delegate(def).update({
        where: { id },
        data: payload as Record<string, unknown>,
      });
      return this.serialize(def, record);
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  async remove(resource: string, id: string): Promise<{ deleted: true; id: string }> {
    const def = this.defFor(resource, 'delete');
    if (!UUID_PATTERN.test(id)) throw new BadRequestException('id must be a UUID');
    try {
      await this.delegate(def).delete({ where: { id } });
      return { deleted: true as const, id };
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Validation & coercion
  // ---------------------------------------------------------------------------

  private validatePayload(
    def: CrudModelDef,
    data: Record<string, unknown>,
    opts: { forCreate: boolean },
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('Request body must be a JSON object');
    }

    const payload: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(data)) {
      const field = def.fields[key];
      if (!field) throw new BadRequestException(`Unknown field "${key}"`);
      if (!field.writable) throw new BadRequestException(`Field "${key}" is not writable`);
      payload[key] = this.coerce(field, key, raw);
    }

    if (opts.forCreate) {
      for (const [name, field] of Object.entries(def.fields)) {
        if (field.required && !(name in payload)) {
          throw new BadRequestException(`Missing required field "${name}"`);
        }
      }
    }
    return payload;
  }

  private coerce(field: CrudModelField, key: string, raw: unknown): unknown {
    switch (field.kind) {
      case 'uuid':
        if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
          throw new BadRequestException(`Field "${key}" must be a UUID`);
        }
        return raw;
      case 'string':
        if (typeof raw !== 'string') {
          throw new BadRequestException(`Field "${key}" must be a string`);
        }
        return raw;
      case 'int':
        if (
          (typeof raw === 'number' && Number.isInteger(raw)) ||
          (typeof raw === 'string' && INT_PATTERN.test(raw))
        ) {
          return Number(raw);
        }
        throw new BadRequestException(`Field "${key}" must be an integer`);
      case 'decimal': {
        const valid =
          (typeof raw === 'number' && Number.isFinite(raw)) ||
          (typeof raw === 'string' && DECIMAL_PATTERN.test(raw));
        if (!valid) throw new BadRequestException(`Field "${key}" must be a decimal number`);
        return String(raw);
      }
      case 'boolean':
        if (typeof raw !== 'boolean') {
          throw new BadRequestException(`Field "${key}" must be a boolean`);
        }
        return raw;
      case 'enum':
        if (typeof raw !== 'string' || !field.enumValues?.includes(raw)) {
          throw new BadRequestException(
            `Field "${key}" must be one of: ${(field.enumValues ?? []).join(', ')}`,
          );
        }
        return raw;
      case 'json':
        if (raw === undefined || raw === null) {
          throw new BadRequestException(`Field "${key}" must be a JSON value`);
        }
        return raw;
      case 'datetime': {
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
          throw new BadRequestException(`Field "${key}" must be an ISO date string`);
        }
        return new Date(raw);
      }
    }
  }

  private buildFilters(
    def: CrudModelDef,
    filters: CrudListOptions['filters'],
  ): Record<string, unknown> {
    const rawFilters = Array.isArray(filters)
      ? filters
      : typeof filters === 'string' && filters.length > 0
        ? [filters]
        : [];
    const where: Record<string, unknown> = {};
    for (const entry of rawFilters) {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex <= 0) {
        throw new BadRequestException('filter must be "field:value"');
      }
      const fieldName = entry.slice(0, separatorIndex);
      const rawValue = entry.slice(separatorIndex + 1);
      const field = def.fields[fieldName];
      if (!field || !field.visible) {
        throw new BadRequestException(`Unknown filter field "${fieldName}"`);
      }
      where[fieldName] = this.coerce(field, fieldName, rawValue);
    }
    return where;
  }

  private buildOrderBy(def: CrudModelDef, orderBy: string): Record<string, string> {
    const [fieldName, direction] = orderBy.split(':');
    const field = def.fields[fieldName];
    if (!field || !field.visible) {
      throw new BadRequestException(`Unknown orderBy field "${fieldName}"`);
    }
    if (direction !== 'asc' && direction !== 'desc') {
      throw new BadRequestException('orderBy direction must be "asc" or "desc"');
    }
    return { [fieldName]: direction };
  }

  private select(def: CrudModelDef): Record<string, boolean> {
    const select: Record<string, boolean> = {};
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.visible) select[name] = true;
    }
    return select;
  }

  // ---------------------------------------------------------------------------
  // Serialization & plumbing
  // ---------------------------------------------------------------------------

  private serialize(def: CrudModelDef, record: unknown): Record<string, unknown> {
    const source = record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(def.fields)) {
      if (!field.visible || !(name in source)) continue;
      const value = source[name];
      if (value instanceof Date) out[name] = value.toISOString();
      else if (value instanceof Prisma.Decimal) out[name] = value.toFixed(2);
      else out[name] = value;
    }
    return out;
  }

  private defFor(resource: string, method: CrudMethod): CrudModelDef {
    const def = CRUD_BY_RESOURCE.get(resource);
    if (!def) throw new NotFoundException(`Unknown admin resource "${resource}"`);
    if (!def.methods.includes(method)) {
      throw new MethodNotAllowedException(
        `${method.toUpperCase()} is not allowed on "${resource}"`,
      );
    }
    return def;
  }

  private delegate(def: CrudModelDef): CrudDelegate {
    const client = this.prisma as unknown as Record<string, unknown>;
    const delegate = client[def.modelName];
    if (!delegate || typeof delegate !== 'object') {
      throw new Error(`CRUD: model "${def.modelName}" has no Prisma delegate`);
    }
    return delegate as CrudDelegate;
  }

  private async run(def: CrudModelDef, operation: () => Promise<unknown>): Promise<unknown> {
    try {
      const record = await operation();
      return this.serialize(def, record);
    } catch (error) {
      this.rethrowPrisma(error);
    }
  }

  private rethrowPrisma(error: unknown): never {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      switch (error.code) {
        case 'P2002':
          throw new ConflictException('Unique constraint violation');
        case 'P2025':
          throw new NotFoundException('Record not found');
        case 'P2003':
          throw new BadRequestException('Referenced record does not exist');
        case 'P2011':
        case 'P2012':
          throw new BadRequestException('A required field is missing');
        default:
          throw error;
      }
    }
    if (error instanceof Prisma.PrismaClientValidationError) {
      throw new BadRequestException('Invalid field value');
    }
    throw error;
  }
}
