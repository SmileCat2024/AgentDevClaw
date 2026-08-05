/**
 * Tiny DOM harness for front-end rendering tests.
 *
 * It deliberately implements only the DOM surface used by Generative UI, but
 * preserves child trees and event listeners so tests verify user-visible
 * behavior rather than renderer internals.
 */

function classNames(element) {
  return new Set(String(element.className || '').split(/\s+/).filter(Boolean));
}

function matchesSelector(element, selector) {
  const classMatch = selector.match(/^\.([\w-]+)/);
  const idMatch = selector.match(/^#([\w-]+)$/);
  const dataMatch = selector.match(/\[data-([\w-]+)="([^"]*)"\]/);

  if (idMatch) return element.id === idMatch[1];
  if (classMatch && !classNames(element).has(classMatch[1])) return false;
  if (dataMatch) {
    const key = dataMatch[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (element.dataset[key] !== dataMatch[2]) return false;
  }
  return Boolean(classMatch || dataMatch);
}

export function createDomHarness() {
  const elementsById = new Map();

  class TestElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.className = '';
      this.parentNode = null;
      this.listeners = new Map();
      this._id = '';
      this._textContent = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.classList = {
        add: (...names) => {
          const namesSet = classNames(this);
          names.forEach((name) => namesSet.add(name));
          this.className = [...namesSet].join(' ');
        },
        remove: (...names) => {
          const namesSet = classNames(this);
          names.forEach((name) => namesSet.delete(name));
          this.className = [...namesSet].join(' ');
        },
        toggle: (name, force) => {
          const namesSet = classNames(this);
          const enabled = force === undefined ? !namesSet.has(name) : Boolean(force);
          if (enabled) namesSet.add(name);
          else namesSet.delete(name);
          this.className = [...namesSet].join(' ');
          return enabled;
        },
        contains: (name) => classNames(this).has(name),
      };
    }

    get id() { return this._id; }

    set id(value) {
      if (this._id) elementsById.delete(this._id);
      this._id = String(value || '');
      if (this._id) elementsById.set(this._id, this);
    }

    get textContent() { return this._textContent; }

    set textContent(value) {
      this._textContent = String(value ?? '');
      this.children = [];
    }

    get innerHTML() { return ''; }

    set innerHTML(value) {
      if (value === '') {
        this.children = [];
        this._textContent = '';
      }
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }

    focus() {}

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    dispatch(type) {
      for (const listener of this.listeners.get(type) || []) {
        listener({ target: this, preventDefault() {} });
      }
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const visit = (element) => {
        for (const child of element.children) {
          if (matchesSelector(child, selector)) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    }
  }

  const document = {
    createElement(tagName) { return new TestElement(tagName); },
    createTextNode(text) { return { textContent: String(text) }; },
    getElementById(id) { return elementsById.get(id) || null; },
    querySelector(selector) {
      return this.body.querySelector(selector) || this.head.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)];
    },
    addEventListener() {},
    body: new TestElement('body'),
    head: new TestElement('head'),
    documentElement: new TestElement('html'),
    readyState: 'complete',
  };

  return {
    document,
    createMount(id) {
      const mount = document.createElement('div');
      mount.id = id;
      document.body.appendChild(mount);
      return mount;
    },
    findAll(root, selector) {
      const result = [];
      if (matchesSelector(root, selector)) result.push(root);
      return result.concat(root.querySelectorAll(selector));
    },
  };
}
