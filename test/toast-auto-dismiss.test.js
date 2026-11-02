import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function makeToastHarness() {
  const timers = [];
  const context = createFrontendSandbox({
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  const source = fs.readFileSync(new URL('../public/src/modules/toast-notify.js', import.meta.url), 'utf8');
  context.run(source);
  context.document.querySelector = () => null;
  context.document.body.appendChild = (element) => { element.parentNode = context.document.body; };
  const container = {
    parentNode: context.document.body,
    children: [],
    appendChild(element) { this.children.push(element); element.parentNode = this; },
    removeChild(element) { this.children = this.children.filter((item) => item !== element); element.parentNode = null; },
  };
  context.document.getElementById = (id) => id === 'toast-container' ? container : null;
  const elements = [];
  context.document.createElement = () => {
    const element = {
      attributes: {}, children: [], leaving: false,
      classList: { add(name) { if (name === 'toast-leaving') element.leaving = true; } },
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) { this.children.push(child); child.parentNode = this; },
      querySelector(selector) {
        if (selector === '.toast-close') return { style: {}, addEventListener() {} };
        return null;
      },
    };
    elements.push(element);
    return element;
  };
  context.window.ClawToast.getToastElements = () => elements;
  return { context, timers };
}

test('an info toast with an explicit autoDismiss duration is actually dismissed', () => {
  const { context, timers } = makeToastHarness();
  context.window.ClawToast.show({ id: 'staged-input', status: 'info', title: 'Staged', autoDismiss: 5000 });

  assert.equal(timers.length, 1, 'the info toast must schedule the requested timeout');
  assert.equal(timers[0].delay, 5000);
  timers[0].callback();
  timers.find((timer, index) => index > 0 && !timer.cleared)?.callback();
  assert.equal(context.window.ClawToast.getToastElements()[0].leaving, true,
    'the scheduled timeout must initiate dismissal of the visible notice');
});
