#!/usr/bin/env node

/**
 * Feature 结构验证脚本
 *
 * 验证一个 AgentDev Feature 项目是否符合框架约定：
 * - package.json 完整性
 * - 编译产物可导入
 * - Feature 类导出命名合规
 * - AgentFeature 接口实现（name、getTools、钩子等）
 *
 * 用法: node validate-feature.mjs <feature-directory>
 * 输出: JSON 格式的验证报告到 stdout
 */

import { pathToFileURL } from 'url';
import { join, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

const DECISION_LIFECYCLES = ['StepFinish', 'ToolUse'];

// ========== 报告工具 ==========

function pass(checks, name, detail) {
  checks.push({ name, passed: true, detail: detail || '' });
}

function fail(checks, errors, name, detail) {
  checks.push({ name, passed: false, detail: detail || '' });
  errors.push(`${name}: ${detail || '不满足要求'}`);
}

function warn(checks, warnings, name, detail) {
  checks.push({ name, passed: false, detail: detail || '' });
  warnings.push(`${name}: ${detail || '建议配置'}`);
}

// ========== 阶段 1: package.json 检查 ==========

function checkPackageJson(featureDir) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const packageJsonPath = join(featureDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    fail(checks, errors, 'package.json', '文件不存在，不是有效的 Feature 项目');
    return { pkg: null, checks, errors, warnings };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (e) {
    fail(checks, errors, 'package.json', `解析失败: ${e.message}`);
    return { pkg: null, checks, errors, warnings };
  }

  pass(checks, 'package.json', '存在且可解析');

  if (typeof pkg.name === 'string' && pkg.name.trim()) {
    pass(checks, 'package.json.name', `"${pkg.name}"`);
  } else {
    fail(checks, errors, 'package.json.name', '缺少或为空');
  }

  if (typeof pkg.version === 'string' && pkg.version.trim()) {
    pass(checks, 'package.json.version', `"${pkg.version}"`);
  } else {
    fail(checks, errors, 'package.json.version', '缺少或为空');
  }

  if (typeof pkg.main === 'string' && pkg.main.trim()) {
    pass(checks, 'package.json.main', `"${pkg.main}"`);
  } else {
    warn(checks, warnings, 'package.json.main', '缺少或为空，可能影响 Feature 加载');
  }

  const hasBuildScript = pkg.scripts && typeof pkg.scripts.build === 'string';
  if (hasBuildScript) {
    pass(checks, 'build 脚本', `"${pkg.scripts.build}"`);
  } else {
    warn(checks, warnings, 'build 脚本', '未配置');
  }

  const hasAgentDevPeer = pkg.peerDependencies && typeof pkg.peerDependencies.agentdev === 'string';
  if (hasAgentDevPeer) {
    pass(checks, 'agentdev peerDependency', `"${pkg.peerDependencies.agentdev}"`);
  } else {
    warn(checks, warnings, 'agentdev peerDependency', '未声明');
  }

  return { pkg, checks, errors, warnings };
}

// ========== 阶段 2: 编译产物导入 ==========

async function checkModuleImport(featureDir, pkg) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const mainEntry = (typeof pkg.main === 'string' && pkg.main.trim())
    ? pkg.main.trim()
    : 'dist/index.js';
  const distPath = join(featureDir, mainEntry);

  if (!existsSync(distPath)) {
    fail(checks, errors, '编译产物', `${mainEntry} 不存在，需要先 npm run build`);
    return { mod: null, featureEntries: [], checks, errors, warnings };
  }
  pass(checks, '编译产物', mainEntry);

  let mod;
  try {
    mod = await import(pathToFileURL(distPath).href + '?t=' + Date.now());
  } catch (e) {
    fail(checks, errors, '模块导入', e.message);
    return { mod: null, featureEntries: [], checks, errors, warnings };
  }
  pass(checks, '模块导入', '成功');

  const featureEntries = Object.entries(mod).filter(
    ([name, value]) => typeof value === 'function' && /Feature$/i.test(name)
  );

  if (featureEntries.length === 0) {
    const allExports = Object.keys(mod).join(', ') || '(无导出)';
    fail(checks, errors, 'Feature 类导出', `未找到以 Feature 结尾的类。当前导出: ${allExports}`);
    return { mod, featureEntries: [], checks, errors, warnings };
  }

  pass(checks, 'Feature 类导出', featureEntries.map(([n]) => n).join(', '));

  return { mod, featureEntries, checks, errors, warnings };
}

// ========== 阶段 3: Feature 实例与接口检查 ==========

function checkFeatureInstance(featureEntries, featureDir) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const [featureClassName, FeatureClass] = featureEntries[0];

  let instance;
  try {
    instance = new FeatureClass({ workspaceDir: featureDir });
  } catch (e) {
    fail(checks, errors, 'Feature 实例化', e.message);
    return { instance: null, featureClassName, checks, errors, warnings };
  }
  pass(checks, 'Feature 实例化', featureClassName);

  // name 属性
  if (typeof instance.name === 'string' && instance.name.trim()) {
    pass(checks, 'name 属性', `"${instance.name}"`);
  } else {
    fail(checks, errors, 'name 属性', '缺少或非字符串');
  }

  // dependencies
  if (Array.isArray(instance.dependencies) && instance.dependencies.length > 0) {
    pass(checks, 'dependencies', instance.dependencies.join(', '));
  }

  // getTools
  if (typeof instance.getTools === 'function') {
    try {
      const tools = instance.getTools();
      if (Array.isArray(tools)) {
        const validTools = tools.filter(t =>
          t && typeof t.name === 'string' && typeof t.description === 'string' && typeof t.execute === 'function'
        );
        const toolNames = tools.map(t => t?.name).filter(Boolean);
        if (validTools.length === tools.length) {
          pass(checks, `getTools(): ${tools.length} 个工具`, toolNames.join(', '));
        } else {
          fail(checks, errors, `getTools(): ${validTools.length}/${tools.length} 合法`, `不合法的工具缺少 name/description/execute`);
        }
      } else {
        fail(checks, errors, 'getTools() 返回值', '不是数组');
      }
    } catch (e) {
      warn(checks, warnings, 'getTools() 调用', e.message);
    }
  } else {
    pass(checks, 'getTools()', '未实现（Feature 可能只提供 hooks）');
  }

  // 反向钩子装饰器
  const hookDecisions = instance.constructor._hookDecisions;
  if (hookDecisions && hookDecisions.size > 0) {
    const hookSummary = Array.from(hookDecisions.entries())
      .map(([lifecycle, method]) => `@${lifecycle} → ${method}`)
      .join('; ');
    pass(checks, '反向钩子', hookSummary);

    for (const dl of DECISION_LIFECYCLES) {
      const entry = hookDecisions.get(dl);
      if (entry && entry.includes(',')) {
        fail(checks, errors, `@${dl} 唯一性`, `注册了多个方法(${entry})，流程控制型钩子只能有一个`);
      }
    }
  } else {
    pass(checks, '反向钩子', '未使用');
  }

  // 其他可选方法
  const optionalMethods = [
    'getAsyncTools', 'getPackageInfo', 'getTemplateNames',
    'getRenderTemplates', 'getContextInjectors', 'onInitiate', 'onDestroy',
    'captureState', 'restoreState', 'beforeRollback', 'afterRollback',
  ];
  const implemented = optionalMethods.filter(m => typeof instance[m] === 'function');
  if (implemented.length > 0) {
    pass(checks, '其他方法', implemented.join(', '));
  }

  // agentdev-feature.json
  const manifestPath = join(featureDir, 'agentdev-feature.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifest.featureTypes) && manifest.featureTypes.length > 0) {
        pass(checks, 'agentdev-feature.json', `featureTypes: ${manifest.featureTypes.join(', ')}`);
      } else {
        warn(checks, warnings, 'agentdev-feature.json', '缺少 featureTypes');
      }
    } catch (e) {
      warn(checks, warnings, 'agentdev-feature.json', `解析失败: ${e.message}`);
    }
  }

  return { instance, featureClassName, checks, errors, warnings };
}

// ========== 主流程 ==========

async function main() {
  const featureDir = resolve(process.argv[2] || '.');

  if (!existsSync(featureDir)) {
    output({ valid: false, featureDir, errors: [`目录不存在: ${featureDir}`], checks: [], warnings: [],
      summary: { total: 0, passed: 0, failed: 0, errors: 1, warnings: 0 } });
    process.exit(1);
    return;
  }

  const allChecks = [];
  const allErrors = [];
  const allWarnings = [];

  // 阶段 1
  const r1 = checkPackageJson(featureDir);
  allChecks.push(...r1.checks);
  allErrors.push(...r1.errors);
  allWarnings.push(...r1.warnings);
  if (!r1.pkg) {
    return outputReport(featureDir, allChecks, allErrors, allWarnings);
  }

  // 阶段 2
  const r2 = await checkModuleImport(featureDir, r1.pkg);
  allChecks.push(...r2.checks);
  allErrors.push(...r2.errors);
  allWarnings.push(...r2.warnings);
  if (r2.featureEntries.length === 0) {
    return outputReport(featureDir, allChecks, allErrors, allWarnings);
  }

  // 阶段 3
  const r3 = checkFeatureInstance(r2.featureEntries, featureDir);
  allChecks.push(...r3.checks);
  allErrors.push(...r3.errors);
  allWarnings.push(...r3.warnings);

  const instance = r3.instance;
  outputReport(featureDir, allChecks, allErrors, allWarnings, instance, r3.featureClassName);
}

function outputReport(featureDir, checks, errors, warnings, instance = null, featureClassName = '') {
  const report = {
    valid: errors.length === 0,
    featureDir,
    featureClass: featureClassName || undefined,
    featureName: instance && typeof instance.name === 'string' ? instance.name : undefined,
    tools: instance && typeof instance.getTools === 'function'
      ? (instance.getTools() || []).map(t => t?.name).filter(Boolean) : [],
    hooks: instance
      ? Array.from((instance.constructor._hookDecisions || new Map()).entries())
          .map(([lifecycle, method]) => ({ lifecycle, method }))
      : [],
    summary: {
      total: checks.length,
      passed: checks.filter(c => c.passed).length,
      failed: checks.filter(c => !c.passed).length,
      errors: errors.length,
      warnings: warnings.length,
    },
    checks,
    errors,
    warnings,
  };
  output(report);
}

function output(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

main().catch(e => {
  output({
    valid: false,
    errors: [`验证脚本异常: ${e.message}`],
    checks: [],
    warnings: [],
    summary: { total: 0, passed: 0, failed: 0, errors: 1, warnings: 0 },
  });
  process.exit(1);
});
