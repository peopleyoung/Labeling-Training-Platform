import type { AnnotationAuditChange, AnnotationAuditCounts, AnnotationRecord, UserRole } from '../shared/contracts';

export interface AnnotationActor {
  id: string;
  role: UserRole;
}

const attributionFields = new Set(['createdBy', 'createdByRole', 'createdAt', 'updatedBy', 'updatedByRole', 'updatedAt']);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function comparableRecord(record: AnnotationRecord) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !attributionFields.has(key)));
}

function changedFields(before: AnnotationRecord, after: AnnotationRecord) {
  const keys = new Set([...Object.keys(comparableRecord(before)), ...Object.keys(comparableRecord(after))]);
  return [...keys].filter((key) => JSON.stringify(stableValue((before as unknown as Record<string, unknown>)[key])) !== JSON.stringify(stableValue((after as unknown as Record<string, unknown>)[key]))).sort();
}

function changedRecord(record: AnnotationRecord, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, (record as unknown as Record<string, unknown>)[field]]));
}

export function attributeAnnotations(current: AnnotationRecord[], incoming: AnnotationRecord[], actor: AnnotationActor, now = new Date().toISOString()): AnnotationRecord[] {
  const currentById = new Map(current.map((record) => [record.id, record]));
  return incoming.map((record) => {
    const previous = currentById.get(record.id);
    const createdBy = previous
      ? previous.createdBy ?? (actor.role === 'reviewer' ? 'legacy-annotator' : actor.id)
      : actor.id;
    const createdByRole = previous
      ? previous.createdByRole ?? (actor.role === 'reviewer' ? 'annotator' : actor.role)
      : actor.role;
    return {
      ...record,
      createdBy,
      createdByRole,
      createdAt: previous?.createdAt ?? now,
      updatedBy: actor.id,
      updatedByRole: actor.role,
      updatedAt: now,
    };
  });
}

export function diffAnnotations(before: AnnotationRecord[], after: AnnotationRecord[]): AnnotationAuditChange[] {
  const beforeById = new Map(before.map((record) => [record.id, record]));
  const afterById = new Map(after.map((record) => [record.id, record]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  return ids.flatMap((objectId): AnnotationAuditChange[] => {
    const previous = beforeById.get(objectId);
    const next = afterById.get(objectId);
    if (!previous && next) {
      const fields = Object.keys(comparableRecord(next)).sort();
      return [{ objectId, changeType: 'created' as const, changedFields: fields, after: changedRecord(next, fields) }];
    }
    if (previous && !next) {
      const fields = Object.keys(comparableRecord(previous)).sort();
      return [{ objectId, changeType: 'deleted' as const, changedFields: fields, before: changedRecord(previous, fields) }];
    }
    if (!previous || !next) return [];
    const fields = changedFields(previous, next);
    return fields.length ? [{ objectId, changeType: 'updated' as const, changedFields: fields, before: changedRecord(previous, fields), after: changedRecord(next, fields) }] : [];
  });
}

export function summarizeAnnotationChanges(changes: AnnotationAuditChange[]): AnnotationAuditCounts {
  return changes.reduce((counts, change) => {
    if (change.changeType === 'created') counts.added += 1;
    if (change.changeType === 'updated') counts.modified += 1;
    if (change.changeType === 'deleted') counts.deleted += 1;
    return counts;
  }, { added: 0, modified: 0, deleted: 0 });
}
