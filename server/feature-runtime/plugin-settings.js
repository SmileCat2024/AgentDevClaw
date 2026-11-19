// Claw package settings (ADR-0052 §4a). Native Feature schemas remain inputs;
// compiling this declaration does not execute package code or modify a manifest.
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const PREFIX = '$plugin:';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (value) => typeof value === 'string' && KEY.test(value) && !RESERVED.has(value);
const own = (object, name) => record(object) && Object.hasOwn(object, name) ? object[name] : undefined;

export function pluginSettingsKey(packageName) {
  return PREFIX + packageName.replaceAll('.', '%2E');
}

export function splitPluginSettingsLayer(layer) {
  const settings = Object.create(null);
  const features = Object.create(null);
  for (const [name, value] of Object.entries(layer || {})) {
    if (name.startsWith(PREFIX)) settings[name] = value;
    else features[name] = value;
  }
  return { settings, features };
}

function matches(schema, value) {
  switch (schema.type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    default: return false;
  }
}

function validValue(schema, value) {
  if (!matches(schema, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof value === 'number') {
    if (value < schema.minimum || value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (value.length < schema.minLength || value.length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  }
  return true;
}

export function compilePluginSettings(manifest, featureNames) {
  if (!manifest || !Object.hasOwn(manifest, 'pluginSettings')) return null;
  const invalid = (detail) => { throw new Error(`pluginSettings: ${detail}`); };
  const fields = manifest.pluginSettings?.fields;
  if (!record(fields) || !Object.keys(fields).length) invalid('fields 必须是非空对象');
  const targets = new Set();
  const properties = {};
  const compiled = [];
  const featureSchema = (target) => {
    const schema = own(own(manifest.settings?.features, target?.feature)?.properties, target?.field);
    if (!featureNames.has(target?.feature) || !key(target?.field) || !SCALAR.has(schema?.type)) {
      invalid(`未知或不支持的 Feature 字段 ${target?.feature}.${target?.field}`);
    }
    return schema;
  };
  for (const [name, field] of Object.entries(fields)) {
    if (!key(name) || !record(field)) invalid(`非法字段 ${name}`);
    const hasSchema = Object.hasOwn(field, 'schema');
    const hasReference = Object.hasOwn(field, 'from');
    if (hasSchema === hasReference) invalid(`${name} 必须且只能声明 schema 或 from`);
    let schema = field.schema;
    let nativeTarget = null;
    let browser = field.exposeToUi === true;
    if (Object.hasOwn(field, 'exposeToUi') && typeof field.exposeToUi !== 'boolean') invalid(`${name}.exposeToUi 必须是布尔值`);
    if (hasReference) {
      const from = field.from;
      if (record(from) && Object.keys(from).length === 2 && Object.hasOwn(from, 'feature') && Object.hasOwn(from, 'field')) {
        schema = featureSchema(from);
        nativeTarget = from;
      } else if (record(from) && Object.keys(from).length === 1 && key(from.ui)) {
        schema = own(manifest.ui?.settings?.properties, from.ui);
        if (!schema) invalid(`未知 UI 字段 ${from.ui}`);
        if (from.ui !== name) invalid(`UI 引用 ${from.ui} 必须保留原字段名`);
        browser = true;
      } else invalid(`${name}.from 必须引用一个 Feature 或 UI 字段`);
    }
    if (!record(schema) || !SCALAR.has(schema.type)) invalid(`${name} 仅支持标量 schema`);
    if (schema.pattern !== undefined) {
      try { new RegExp(schema.pattern); } catch { invalid(`${name} 的 pattern 非法`); }
    }
    if (Object.hasOwn(schema, 'default') && !validValue(schema, schema.default)) invalid(`${name} 的默认值不合法`);
    if (field.targets !== undefined && !Array.isArray(field.targets)) invalid(`${name}.targets 必须是数组`);
    const bindings = [];
    for (const target of [...(nativeTarget ? [nativeTarget] : []), ...(field.targets || [])]) {
      const targetSchema = featureSchema(target);
      const id = JSON.stringify([target.feature, target.field]);
      if (targets.has(id)) invalid(`重复绑定 ${target.feature}.${target.field}`);
      if (targetSchema.type !== schema.type) invalid(`${name} 与 ${target.feature}.${target.field} 类型不匹配`);
      if (Object.hasOwn(schema, 'default') && !validValue(targetSchema, schema.default)) invalid(`${name} 的默认值不满足目标字段限制`);
      targets.add(id);
      bindings.push({ feature: target.feature, field: target.field, schema: targetSchema });
    }
    if (browser && [schema, ...bindings.map((binding) => binding.schema)].some((item) => item.sensitive || item.writeOnly || item.format === 'password')) {
      invalid(`敏感字段 ${name} 不得向浏览器消费面公开`);
    }
    // Only project metadata understood by the existing editors; raw package
    // declarations must not flow into their conditional or dynamic controls.
    properties[name] = {
      type: schema.type,
      title: typeof schema.title === 'string' ? schema.title : name,
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      ...(Object.hasOwn(schema, 'default') ? { default: schema.default } : {}),
      ...(Number.isFinite(schema.minimum) ? { min: schema.minimum } : {}),
      ...(Number.isFinite(schema.maximum) ? { max: schema.maximum } : {}),
      ...(schema.type === 'integer' ? { step: 1 } : {}),
    };
    compiled.push({ name, browser, schema, bindings });
  }
  return { properties, fields: compiled };
}

/** Same sparse scalar inheritance for startup, configuration validation and live reads. */
export function resolvePluginSettings(archive, layers = []) {
  const settings = archive.pluginSettings;
  const values = {};
  const browser = {};
  const features = new Map();
  const storageKey = pluginSettingsKey(archive.packageName);
  for (const field of settings?.fields || []) {
    let value = field.schema.default;
    for (const layer of layers) {
      const override = own(own(layer, storageKey), field.name);
      if (override !== undefined) value = override;
    }
    if (value === undefined) continue;
    if (!validValue(field.schema, value) || field.bindings.some((binding) => !validValue(binding.schema, value))) {
      throw new Error(`${archive.packageName} 的插件设置 ${field.name} 不符合声明`);
    }
    values[field.name] = value;
    if (field.browser) browser[field.name] = value;
    for (const binding of field.bindings) {
      const config = features.get(binding.feature) || {};
      config[binding.field] = value;
      features.set(binding.feature, config);
    }
  }
  return { values, browser, features };
}
