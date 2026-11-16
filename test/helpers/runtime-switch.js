import fs from 'node:fs';
import vm from 'node:vm';
import { createRuntimeSwitch } from '../../public/src/modules/runtime-switch.js';

const source = fs.readFileSync(new URL('../../public/src/app-main.js', import.meta.url), 'utf8');
const start = source.indexOf('function createRuntimeSwitchHost()');
const end = source.indexOf('// ── Context menu action handlers', start);
if (start < 0 || end < 0) throw new Error('Runtime switch classic host is missing');
export const runtimeSwitchHostSource = source.slice(start, end);

// Exercise the real module with the real classic adapter and live VM state.
export function installRuntimeSwitch(context) {
  vm.runInContext(runtimeSwitchHostSource, context);
  Object.assign(context.window || context, createRuntimeSwitch(vm.runInContext('createRuntimeSwitchHost()', context)));
}
