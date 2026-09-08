import { z } from 'zod';
import type { Dataset } from './contracts';

export const initialCategoryNames = ['目标检测', '语义分割', '关键点检测', '实例分割', '车道线检测'] as const;

export interface TaskCategory {
  id: string;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
}

export interface BusinessTask extends TaskCategory {
  categoryId: string;
  datasetCount: number;
}

export interface TaskCatalog {
  categories: TaskCategory[];
  taskTypes: BusinessTask[];
}

export const catalogInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  enabled: z.boolean().default(true),
}).strict();
export type CatalogInput = z.infer<typeof catalogInputSchema>;
export const catalogUpdateSchema = catalogInputSchema.extend({
  description: catalogInputSchema.shape.description.removeDefault(),
  sortOrder: catalogInputSchema.shape.sortOrder.removeDefault(),
  enabled: catalogInputSchema.shape.enabled.removeDefault(),
}).partial();

export const datasetBindingSchema = z.object({
  taskTypeId: z.string().min(1),
  expectedTaskTypeId: z.string().nullable(),
  confirmed: z.literal(true),
}).strict();

const dateOnly = z.iso.date();
export const dataCenterQuerySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0),
  categoryCode: z.string().max(160).optional(),
  taskTypeCode: z.string().max(160).optional(),
  query: z.string().trim().max(200).default(''),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((input) => !input.from || !input.to || input.from <= input.to, { message: '开始日期不能晚于结束日期', path: ['to'] });
export type DataCenterQuery = z.infer<typeof dataCenterQuerySchema>;
export interface DataCenterResult {
  categories: Array<TaskCategory & { datasetCount: number }>;
  taskTypes: BusinessTask[];
  items: Dataset[];
  total: number;
  page: number;
  pageSize: number;
}

// Browser offset is minutes west of UTC, matching Date.getTimezoneOffset().
export function creationBounds(input: Pick<DataCenterQuery, 'from' | 'to' | 'timezoneOffset'>) {
  const offset = input.timezoneOffset * 60000;
  return {
    from: input.from ? new Date(Date.parse(`${input.from}T00:00:00Z`) + offset).toISOString() : undefined,
    until: input.to ? new Date(Date.parse(`${input.to}T00:00:00Z`) + offset + 86400000).toISOString() : undefined,
  };
}
