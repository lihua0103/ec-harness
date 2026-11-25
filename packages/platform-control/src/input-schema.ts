/** 封闭参数 schema（R1/R3）：声明进计划身份，提交值在 Run 冻结前校验。
 *
 *  合同是一个**明示的封闭 JSON Schema 子集**，不引入第三方校验器：
 *  - 登记时（registry.validateDraft → assertClosedSchema）拒绝任何不支持的关键字，
 *    因此不存在「声明了却被静默忽略」的校验语义；
 *  - Run 创建/换批的同一冻结入口（RunRepository.create → validateRunInput）按声明校验
 *    applicationOptions；未声明 inputSchema 的应用保持 opaque 透传（诚实的现状合同）。
 *  - 场景归属独立于 schema：提交了 applicationOptions.listingType 就必须属于应用声明的
 *    listingTypes；未声明场景的应用不接受该参数。
 *
 *  支持关键字：type / properties / required / additionalProperties(布尔) / items /
 *  enum / const / minLength / maxLength / minimum / maximum / minItems / maxItems。
 *  type 仅取单值：object / array / string / number / integer / boolean / null。 */
import { PlatformError } from './registry.js';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (isRecord(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });

/** 登记时校验：schema 必须是封闭子集内的良构 JSON 对象；不支持的关键字当场拒绝。 */
export function assertClosedSchema(schema: unknown, path = 'inputSchema'): void {
  if (!isRecord(schema)) throw new PlatformError('APP_DESCRIPTOR_INVALID', `${path} must be an object`);
  for (const [keyword, value] of Object.entries(schema)) {
    const at = `${path}.${keyword}`;
    if (!KEYWORDS.has(keyword)) throw new PlatformError('APP_DESCRIPTOR_INVALID', `${at} unsupported keyword`);
    switch (keyword) {
      case 'type':
        if (typeof value !== 'string' || !TYPES.has(value)) throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        break;
      case 'properties':
        if (!isRecord(value)) throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        for (const [key, sub] of Object.entries(value)) assertClosedSchema(sub, `${at}.${key}`);
        break;
      case 'required':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
          throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        }
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') throw new PlatformError('APP_DESCRIPTOR_INVALID', `${at} must be boolean`);
        break;
      case 'items':
        assertClosedSchema(value, at);
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        break;
      case 'minLength': case 'maxLength': case 'minItems': case 'maxItems':
        if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        break;
      case 'minimum': case 'maximum':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new PlatformError('APP_DESCRIPTOR_INVALID', at);
        break;
      // const：任意 JSON 值均可。
    }
  }
}

const fail = (path: string, reason: string): never => {
  throw new PlatformError('RUN_INPUT_INVALID', `${path}: ${reason}`);
};

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): void {
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const expected = schema.type as string;
    const ok = expected === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === expected;
    if (!ok) fail(path, `expected ${expected}, got ${actual}`);
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((item) => canonical(item) === canonical(value))) {
    fail(path, 'value not in enum');
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) fail(path, 'value !== const');
  if (isRecord(value)) {
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in value)) fail(`${path}.${key}`, 'required property missing');
    }
    const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) fail(`${path}.${key}`, 'additional property not allowed');
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) validateValue(sub as Record<string, unknown>, value[key], `${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) fail(path, 'too few items');
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) fail(path, 'too many items');
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`));
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) fail(path, 'string too short');
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) fail(path, 'string too long');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) fail(path, 'below minimum');
    if (schema.maximum !== undefined && value > (schema.maximum as number)) fail(path, 'above maximum');
  }
}

/** Run 冻结前校验（创建与换批共用）：非法输入抛 RUN_INPUT_INVALID，调用方事务回滚、零写入。
 *  descriptor 来自服务端登记记录，绝不取自请求参数。 */
export function validateRunInput(
  descriptor: { listingTypes?: string[]; inputSchema?: unknown },
  input: unknown,
): void {
  const options = isRecord(input) ? input.applicationOptions : undefined;
  // 场景归属：提交了 listingType 就必须属于应用自己的声明；未声明场景的应用不接受它。
  if (isRecord(options) && options.listingType !== undefined) {
    const declared = descriptor.listingTypes;
    if (typeof options.listingType !== 'string'
      || !Array.isArray(declared) || declared.length === 0
      || !declared.includes(options.listingType)) {
      fail('applicationOptions.listingType', 'not a scenario declared by this application');
    }
  }
  // 声明了封闭 schema 的应用必须提交符合合同的 applicationOptions；未声明则 opaque 透传。
  if (descriptor.inputSchema !== undefined) {
    if (options === undefined) fail('applicationOptions', 'required by the declared input schema');
    validateValue(descriptor.inputSchema as Record<string, unknown>, options, 'applicationOptions');
  }
}
