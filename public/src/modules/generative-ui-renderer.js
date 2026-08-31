/**
 * generative-ui-renderer.js
 *
 * Pure DOM renderer for Generative UI specs.
 *
 * No framework, no innerHTML for user-facing content (XSS safety).
 * Uses createElement / textContent / setAttribute only.
 *
 * Input: a validated GenerativeUI spec + a mutable ViewState object.
 * Output: a DOM element tree.
 *
 * ViewState shape: { [fieldName]: value }
 *
 * ViewState intentionally contains only user overrides.  The rendered control
 * value is resolved from ViewState first and then from spec.initialValues.
 * Submission reads the rendered controls, so prefilled values and untouched
 * browser defaults are included without making them look like local edits.
 *   - string  for TextInput, Textarea, Select, DateInput, SegmentedControl
 *   - number  for NumberInput
 *   - number  for Slider
 *   - boolean for Checkbox, Switch
 *   - string  for RadioGroup (selected option id)
 *
 * Exposed globally:
 *   - renderGenUISpec(spec, viewState, callbacks) → HTMLElement
 *   - createGenUIViewState() → fresh empty object
 */

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

function createGenUIViewState() {
  return {};
}

/**
 * @param {Object} spec      — validated GenerativeUI spec
 * @param {Object} viewState — mutable { fieldName: value }
 * @param {Object} callbacks — { onSubmit(actionId, action, fields), onReset(actionId, action) }
 * @returns {HTMLElement}
 */
function renderGenUISpec(spec, viewState, callbacks) {
  const elements = spec.elements || {};
  const actions = spec.actions || {};
  const initialValues = spec.initialValues || {};
  const rootEl = elements[spec.root];
  if (!rootEl) {
    const fallback = document.createElement('div');
    fallback.className = 'gen-ui-error';
    fallback.textContent = 'Spec root element not found';
    return fallback;
  }

  const ctx = {
    elements,
    actions,
    initialValues,
    viewState,
    callbacks,
    // fieldName -> current control value reader.  Reading controls at submit
    // time keeps the payload aligned with what the user can actually see.
    fieldReaders: new Map(),
  };
  return _renderElement(spec.root, rootEl, ctx, new Set());
}

// ═══════════════════════════════════════════════════════════════
// Internal: element dispatcher
// ═══════════════════════════════════════════════════════════════

function _renderElement(id, def, ctx, visited) {
  if (visited.has(id)) {
    const err = document.createElement('div');
    err.className = 'gen-ui-error';
    err.textContent = 'Circular reference: ' + id;
    return err;
  }
  visited.add(id);

  const handler = _COMPONENT_HANDLERS[def.type];
  if (!handler) {
    const err = document.createElement('div');
    err.className = 'gen-ui-error';
    err.textContent = 'Unknown component: ' + def.type;
    return err;
  }

  const el = handler(def, ctx, visited);
  el.dataset.genUiElement = id;
  return el;
}

// ═══════════════════════════════════════════════════════════════
// Layout components
// ═══════════════════════════════════════════════════════════════

function _renderStack(def, ctx, visited) {
  const el = document.createElement('div');
  el.className = 'gen-ui-stack';
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = _gapToCss(def.props?.gap || 'md');
  if (def.props?.align) el.style.alignItems = _alignToCss(def.props.align);
  const childVisited = new Set(visited);
  for (const childId of (def.children || [])) {
    const childDef = ctx.elements[childId];
    if (childDef) {
      el.appendChild(_renderElement(childId, childDef, ctx, childVisited));
    }
  }
  return el;
}

function _genUiRenderRow(def, ctx, visited) {
  const el = document.createElement('div');
  el.className = 'gen-ui-row';
  el.style.display = 'flex';
  el.style.flexDirection = 'row';
  el.style.gap = _gapToCss(def.props?.gap || 'md');
  el.style.alignItems = _alignToCss(def.props?.align || 'center');
  // A right-side panel is narrow by design. Rows wrap by default so controls
  // cannot overflow; agents can opt out only for deliberate compact layouts.
  if (def.props?.wrap !== false) el.style.flexWrap = 'wrap';
  const childVisited = new Set(visited);
  for (const childId of (def.children || [])) {
    const childDef = ctx.elements[childId];
    if (childDef) {
      el.appendChild(_renderElement(childId, childDef, ctx, childVisited));
    }
  }
  return el;
}

function _renderGrid(def, ctx, visited) {
  const el = document.createElement('div');
  el.className = 'gen-ui-grid';
  el.style.display = 'grid';
  el.style.gridTemplateColumns = `repeat(${def.props?.columns || 2}, minmax(0, 1fr))`;
  el.style.gap = _gapToCss(def.props?.gap || 'md');
  const childVisited = new Set(visited);
  for (const childId of (def.children || [])) {
    const childDef = ctx.elements[childId];
    if (childDef) {
      el.appendChild(_renderElement(childId, childDef, ctx, childVisited));
    }
  }
  return el;
}

function _renderCard(def, ctx, visited) {
  const el = document.createElement('div');
  el.className = 'gen-ui-card';
  if (def.props?.variant === 'subtle') el.classList.add('variant-subtle');
  if (def.props?.variant === 'emphasis') el.classList.add('variant-emphasis');
  if (def.props?.title) {
    const title = document.createElement('div');
    title.className = 'gen-ui-card-title';
    title.textContent = def.props.title;
    el.appendChild(title);
  }
  const body = document.createElement('div');
  body.className = 'gen-ui-card-body';
  const childVisited = new Set(visited);
  for (const childId of (def.children || [])) {
    const childDef = ctx.elements[childId];
    if (childDef) {
      body.appendChild(_renderElement(childId, childDef, ctx, childVisited));
    }
  }
  el.appendChild(body);
  return el;
}

function _renderDivider() {
  const el = document.createElement('hr');
  el.className = 'gen-ui-divider';
  return el;
}

// ═══════════════════════════════════════════════════════════════
// Display components
// ═══════════════════════════════════════════════════════════════

function _renderText(def) {
  const el = document.createElement('div');
  el.className = 'gen-ui-text';
  const variant = def.props?.variant || 'body';
  if (variant !== 'body') el.classList.add('text-' + variant);
  if (def.props?.tone && def.props.tone !== 'default') el.classList.add('tone-' + def.props.tone);
  el.textContent = def.props?.content || '';
  return el;
}

function _renderBadge(def) {
  const el = document.createElement('span');
  el.className = 'gen-ui-badge';
  const variant = def.props?.variant || 'default';
  if (variant !== 'default') el.classList.add('badge-' + variant);
  el.textContent = def.props?.text || '';
  return el;
}

function _renderTable(def) {
  const columns = def.props?.columns || [];
  const rows = def.props?.rows || [];
  const el = document.createElement('div');
  el.className = 'gen-ui-table-wrap';
  const table = document.createElement('table');
  table.className = 'gen-ui-table';

  if (columns.length > 0) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label || col.key || '';
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const val = row[col.key];
      td.textContent = val == null ? '' : String(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  el.appendChild(table);
  return el;
}

function _renderAlert(def) {
  const p = def.props || {};
  const variant = p.variant || 'info';
  const el = document.createElement('section');
  el.className = 'gen-ui-alert alert-' + variant;
  el.setAttribute('role', variant === 'danger' || variant === 'warning' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'gen-ui-alert-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = ({ info: 'i', success: '✓', warning: '!', danger: '!' })[variant] || 'i';
  el.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'gen-ui-alert-body';
  const title = document.createElement('div');
  title.className = 'gen-ui-alert-title';
  title.textContent = p.title || '';
  body.appendChild(title);
  if (p.description) {
    const description = document.createElement('div');
    description.className = 'gen-ui-alert-description';
    description.textContent = p.description;
    body.appendChild(description);
  }
  el.appendChild(body);
  return el;
}

function _renderProgress(def) {
  const p = def.props || {};
  const value = Math.max(0, Math.min(100, Number(p.value) || 0));
  const tone = p.tone || 'default';
  const el = document.createElement('div');
  el.className = 'gen-ui-progress';

  if (p.label || p.showValue !== false) {
    const header = document.createElement('div');
    header.className = 'gen-ui-progress-header';
    if (p.label) {
      const label = document.createElement('span');
      label.textContent = p.label;
      header.appendChild(label);
    }
    if (p.showValue !== false) {
      const valueLabel = document.createElement('span');
      valueLabel.className = 'gen-ui-progress-value';
      valueLabel.textContent = value + '%';
      header.appendChild(valueLabel);
    }
    el.appendChild(header);
  }

  const track = document.createElement('div');
  track.className = 'gen-ui-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(value));
  if (p.label) track.setAttribute('aria-label', p.label);
  const indicator = document.createElement('div');
  indicator.className = 'gen-ui-progress-indicator progress-' + tone;
  indicator.style.width = value + '%';
  track.appendChild(indicator);
  el.appendChild(track);
  return el;
}

function _renderCodeBlock(def) {
  const p = def.props || {};
  const el = document.createElement('section');
  el.className = 'gen-ui-code-block';
  if (p.title || p.language) {
    const header = document.createElement('div');
    header.className = 'gen-ui-code-block-header';
    const title = document.createElement('span');
    title.textContent = p.title || '';
    header.appendChild(title);
    if (p.language) {
      const language = document.createElement('span');
      language.className = 'gen-ui-code-block-language';
      language.textContent = p.language;
      header.appendChild(language);
    }
    el.appendChild(header);
  }
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  // textContent deliberately keeps Agent-supplied code inert.
  code.textContent = p.code || '';
  pre.appendChild(code);
  el.appendChild(pre);
  return el;
}

// ═══════════════════════════════════════════════════════════════
// Input components
// ═══════════════════════════════════════════════════════════════

function _renderTextInput(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gen-ui-input';
  if (p.placeholder) input.placeholder = p.placeholder;
  if (p.maxLength != null) input.maxLength = p.maxLength;
  if (p.minLength != null) input.minLength = p.minLength;
  if (p.required) input.required = true;

  const current = _getCurrentFieldValue(ctx, name);
  input.value = current != null ? current : '';

  if (name) {
    input.addEventListener('input', () => {
      ctx.viewState[name] = input.value;
    });
    ctx.fieldReaders.set(name, () => input.value);
  }
  wrap.appendChild(input);
  return wrap;
}

function _renderNumberInput(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'gen-ui-input';
  if (p.placeholder) input.placeholder = p.placeholder;
  if (p.min != null) input.min = p.min;
  if (p.max != null) input.max = p.max;
  if (p.step != null) input.step = p.step;
  if (p.required) input.required = true;

  const current = _getCurrentFieldValue(ctx, name);
  input.value = current != null ? current : '';

  if (name) {
    input.addEventListener('input', () => {
      const v = input.value;
      ctx.viewState[name] = v === '' ? null : Number(v);
    });
    ctx.fieldReaders.set(name, () => {
      if (input.value === '') return null;
      const value = Number(input.value);
      return Number.isFinite(value) ? value : null;
    });
  }
  wrap.appendChild(input);
  return wrap;
}

function _renderTextarea(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);

  const ta = document.createElement('textarea');
  ta.className = 'gen-ui-textarea';
  if (p.placeholder) ta.placeholder = p.placeholder;
  if (p.rows != null) ta.rows = p.rows;
  if (p.maxLength != null) ta.maxLength = p.maxLength;
  if (p.required) ta.required = true;

  const current = _getCurrentFieldValue(ctx, name);
  ta.value = current != null ? current : '';

  if (name) {
    ta.addEventListener('input', () => {
      ctx.viewState[name] = ta.value;
    });
    ctx.fieldReaders.set(name, () => ta.value);
  }
  wrap.appendChild(ta);
  return wrap;
}

function _renderSelect(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);

  const sel = document.createElement('select');
  // Match the real Model Settings control contract. The panel upgrades this
  // native select with ClawSelect while the native element remains the single
  // source of truth for form state and browser accessibility fallbacks.
  sel.className = 'settings-input gen-ui-select';
  sel.dataset.genUiSelect = 'true';
  sel.dataset.clawSelect = 'true';
  if (p.required) sel.required = true;

  const options = p.options || [];
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value != null ? opt.value : (opt.id || '');
    o.textContent = opt.label || opt.id || '';
    sel.appendChild(o);
  }

  const selectedVal = _getCurrentFieldValue(ctx, name);
  if (selectedVal != null) sel.value = String(selectedVal);

  if (name) {
    sel.addEventListener('change', () => {
      ctx.viewState[name] = sel.value;
    });
    ctx.fieldReaders.set(name, () => sel.value);
  }
  wrap.appendChild(sel);
  return wrap;
}

function _renderCheckbox(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = document.createElement('label');
  wrap.className = 'gen-ui-checkbox-wrap';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'gen-ui-checkbox';
  if (p.required) cb.required = true;

  const current = _getCurrentFieldValue(ctx, name);
  cb.checked = current === true;

  if (name) {
    cb.addEventListener('change', () => {
      ctx.viewState[name] = cb.checked;
    });
    ctx.fieldReaders.set(name, () => cb.checked);
  }
  wrap.appendChild(cb);

  if (p.label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'gen-ui-checkbox-label';
    labelEl.textContent = p.label;
    wrap.appendChild(labelEl);
  }
  return wrap;
}

function _renderRadioGroup(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = document.createElement('div');
  wrap.className = 'gen-ui-radio-group';
  if (p.label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'gen-ui-radio-group-label';
    labelEl.textContent = p.label;
    wrap.appendChild(labelEl);
  }

  const options = p.options || [];
  const selectedVal = _getCurrentFieldValue(ctx, name);
  let selectedRadio = null;

  for (const opt of options) {
    const labelEl = document.createElement('label');
    labelEl.className = 'gen-ui-radio-item';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'gen-ui-radio-' + name;
    const optionValue = opt.value != null ? opt.value : (opt.id || '');
    radio.value = optionValue;
    radio.checked = (selectedVal === optionValue);
    if (radio.checked) selectedRadio = radio;
    if (p.required) radio.required = true;
    radio.addEventListener('change', () => {
      if (radio.checked && name) {
        ctx.viewState[name] = optionValue;
        selectedRadio = radio;
      }
    });
    labelEl.appendChild(radio);
    const span = document.createElement('span');
    span.textContent = opt.label || opt.id;
    labelEl.appendChild(span);
    wrap.appendChild(labelEl);
  }
  if (name) {
    ctx.fieldReaders.set(name, () => selectedRadio ? selectedRadio.value : null);
  }
  return wrap;
}

function _renderDateInput(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'gen-ui-input gen-ui-date-input';
  if (p.min) input.min = p.min;
  if (p.max) input.max = p.max;
  if (p.required) input.required = true;

  const current = _getCurrentFieldValue(ctx, name);
  input.value = typeof current === 'string' ? current : '';
  if (name) {
    input.addEventListener('input', () => {
      ctx.viewState[name] = input.value || null;
    });
    input.addEventListener('change', () => {
      ctx.viewState[name] = input.value || null;
    });
    ctx.fieldReaders.set(name, () => input.value || null);
  }
  wrap.appendChild(input);
  return wrap;
}

function _renderSlider(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, false);
  wrap.classList.add('gen-ui-slider-field');

  const row = document.createElement('div');
  row.className = 'gen-ui-slider-row';
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'gen-ui-slider';
  input.min = p.min;
  input.max = p.max;
  input.step = p.step == null ? 1 : p.step;
  if (p.label) input.setAttribute('aria-label', p.label);

  const current = _getCurrentFieldValue(ctx, name);
  const initial = typeof current === 'number' && Number.isFinite(current) ? current : p.min;
  input.value = initial;

  let valueLabel = null;
  if (p.showValue !== false) {
    valueLabel = document.createElement('output');
    valueLabel.className = 'gen-ui-slider-value';
    valueLabel.textContent = String(initial);
  }
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (name) ctx.viewState[name] = value;
    if (valueLabel) valueLabel.textContent = String(value);
  });
  if (name) {
    ctx.fieldReaders.set(name, () => {
      const value = Number(input.value);
      return Number.isFinite(value) ? value : null;
    });
  }
  row.appendChild(input);
  if (valueLabel) row.appendChild(valueLabel);
  wrap.appendChild(row);
  return wrap;
}

function _renderSwitch(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = document.createElement('label');
  wrap.className = 'gen-ui-switch';

  const control = document.createElement('span');
  control.className = 'gen-ui-switch-control';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'gen-ui-switch-input';
  const current = _getCurrentFieldValue(ctx, name);
  input.checked = current === true;
  if (name) {
    input.addEventListener('change', () => {
      ctx.viewState[name] = input.checked;
    });
    ctx.fieldReaders.set(name, () => input.checked);
  }
  const track = document.createElement('span');
  track.className = 'gen-ui-switch-track';
  track.setAttribute('aria-hidden', 'true');
  control.appendChild(input);
  control.appendChild(track);
  wrap.appendChild(control);

  const copy = document.createElement('span');
  copy.className = 'gen-ui-switch-copy';
  const label = document.createElement('span');
  label.className = 'gen-ui-switch-label';
  label.textContent = p.label || '';
  copy.appendChild(label);
  if (p.description) {
    const description = document.createElement('span');
    description.className = 'gen-ui-switch-description';
    description.textContent = p.description;
    copy.appendChild(description);
  }
  wrap.appendChild(copy);
  return wrap;
}

function _renderSegmentedControl(def, ctx) {
  const p = def.props || {};
  const name = p.name;
  const wrap = _wrapWithLabel(p.label, p.required);
  const control = document.createElement('div');
  control.className = 'gen-ui-segmented-control';
  control.setAttribute('role', 'radiogroup');
  if (p.label) control.setAttribute('aria-label', p.label);

  let selectedValue = _getCurrentFieldValue(ctx, name);
  const buttons = [];
  for (const opt of (p.options || [])) {
    const optionValue = opt.value != null ? String(opt.value) : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gen-ui-segmented-option';
    button.setAttribute('role', 'radio');
    button.textContent = opt.label || optionValue;
    button.addEventListener('click', () => {
      selectedValue = optionValue;
      if (name) ctx.viewState[name] = optionValue;
      for (const item of buttons) {
        const selected = item.value === optionValue;
        item.button.classList.toggle('is-selected', selected);
        item.button.setAttribute('aria-checked', String(selected));
      }
    });
    const selected = selectedValue === optionValue;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
    buttons.push({ button, value: optionValue });
    control.appendChild(button);
  }
  if (name) ctx.fieldReaders.set(name, () => selectedValue == null ? null : selectedValue);
  wrap.appendChild(control);
  return wrap;
}

// ═══════════════════════════════════════════════════════════════
// Navigation / collapsible layout components
// ═══════════════════════════════════════════════════════════════

function _renderTabs(def, ctx, visited) {
  const p = def.props || {};
  const items = p.items || [];
  const defaultIdx = typeof p.defaultIndex === 'number' ? p.defaultIndex : 0;
  const activeIdx = Math.max(0, Math.min(items.length - 1, defaultIdx));

  const el = document.createElement('div');
  el.className = 'gen-ui-tabs';

  // Tab buttons
  const tabBar = document.createElement('div');
  tabBar.className = 'gen-ui-tabs-bar';
  const tabButtons = [];
  const panels = [];

  for (let i = 0; i < items.length; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gen-ui-tab-button';
    btn.textContent = items[i].label || items[i].value || ('Tab ' + (i + 1));
    btn.classList.toggle('is-active', i === activeIdx);
    btn.addEventListener('click', () => {
      tabButtons.forEach((b, idx) => {
        b.classList.toggle('is-active', idx === i);
        if (panels[idx]) panels[idx].hidden = idx !== i;
      });
    });
    tabButtons.push(btn);
    tabBar.appendChild(btn);
  }
  el.appendChild(tabBar);

  // Tab panels from children
  const contentWrap = document.createElement('div');
  contentWrap.className = 'gen-ui-tabs-content';
  const childIds = def.children || [];
  const childVisited = new Set(visited);
  for (let i = 0; i < childIds.length; i++) {
    const childDef = ctx.elements[childIds[i]];
    if (!childDef) continue;
    const panel = _renderElement(childIds[i], childDef, ctx, childVisited);
    panel.classList.add('gen-ui-tab-panel');
    panel.hidden = i !== activeIdx;
    panels.push(panel);
    contentWrap.appendChild(panel);
  }
  el.appendChild(contentWrap);
  return el;
}

function _renderAccordion(def, ctx, visited) {
  const p = def.props || {};
  const items = p.items || [];
  const multiple = p.multiple !== false;
  const defaultOpen = Array.isArray(p.defaultOpen) ? new Set(p.defaultOpen) : new Set();

  const el = document.createElement('div');
  el.className = 'gen-ui-accordion';

  const childIds = def.children || [];
  const childVisited = new Set(visited);
  const sections = [];

  for (let i = 0; i < items.length; i++) {
    const section = document.createElement('div');
    section.className = 'gen-ui-accordion-section';
    const isOpen = defaultOpen.has(i);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'gen-ui-accordion-header';
    header.classList.toggle('is-open', isOpen);
    header.textContent = items[i].title || ('Section ' + (i + 1));

    const chevron = document.createElement('span');
    chevron.className = 'gen-ui-accordion-chevron';
    chevron.textContent = '▸';
    header.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'gen-ui-accordion-body';
    body.style.display = isOpen ? '' : 'none';

    // Render child as section content
    if (i < childIds.length) {
      const childDef = ctx.elements[childIds[i]];
      if (childDef) {
        body.appendChild(_renderElement(childIds[i], childDef, ctx, childVisited));
      }
    }

    header.addEventListener('click', () => {
      const willOpen = body.style.display === 'none';
      if (willOpen && !multiple) {
        sections.forEach((s) => {
          s.body.style.display = 'none';
          s.header.classList.remove('is-open');
        });
      }
      body.style.display = willOpen ? '' : 'none';
      header.classList.toggle('is-open', willOpen);
    });

    section.appendChild(header);
    section.appendChild(body);
    el.appendChild(section);
    sections.push({ header, body });
  }

  return el;
}

// ═══════════════════════════════════════════════════════════════
// Extended display components
// ═══════════════════════════════════════════════════════════════

function _renderSteps(def) {
  const p = def.props || {};
  const items = p.items || [];
  const current = Math.max(0, Math.min(items.length - 1, Number(p.current) || 0));

  const el = document.createElement('ol');
  el.className = 'gen-ui-steps';

  for (let i = 0; i < items.length; i++) {
    const li = document.createElement('li');
    li.className = 'gen-ui-step';
    if (i < current) li.classList.add('step-completed');
    else if (i === current) li.classList.add('step-current');
    else li.classList.add('step-pending');

    const marker = document.createElement('span');
    marker.className = 'gen-ui-step-marker';
    marker.textContent = String(i + 1);
    li.appendChild(marker);

    const text = document.createElement('div');
    text.className = 'gen-ui-step-text';
    const title = document.createElement('span');
    title.className = 'gen-ui-step-title';
    title.textContent = items[i].title || ('Step ' + (i + 1));
    text.appendChild(title);
    if (items[i].description) {
      const desc = document.createElement('span');
      desc.className = 'gen-ui-step-description';
      desc.textContent = items[i].description;
      text.appendChild(desc);
    }
    li.appendChild(text);
    el.appendChild(li);
  }
  return el;
}

function _renderSpinner(def) {
  const p = def.props || {};
  const el = document.createElement('div');
  el.className = 'gen-ui-spinner';
  const size = p.size || 'md';
  el.classList.add('spinner-' + size);

  const icon = document.createElement('span');
  icon.className = 'gen-ui-spinner-icon';
  icon.setAttribute('role', 'status');
  el.appendChild(icon);

  if (p.label) {
    const label = document.createElement('span');
    label.className = 'gen-ui-spinner-label';
    label.textContent = p.label;
    el.appendChild(label);
  }
  return el;
}

function _renderImage(def) {
  const p = def.props || {};
  const el = document.createElement('img');
  el.className = 'gen-ui-image';
  el.src = p.src || '';
  el.alt = p.alt || '';
  if (p.width != null) el.style.width = p.width + 'px';
  if (p.height != null) el.style.height = p.height + 'px';
  el.loading = 'lazy';
  return el;
}

function _renderAvatar(def) {
  const p = def.props || {};
  const size = p.size || 'md';
  const el = document.createElement('div');
  el.className = 'gen-ui-avatar avatar-' + size;

  if (p.src) {
    const img = document.createElement('img');
    img.src = p.src;
    img.alt = p.name || '';
    el.appendChild(img);
  } else {
    // Initials fallback
    el.classList.add('avatar-initials');
    const name = p.name || '?';
    const parts = name.trim().split(/\s+/);
    const initials = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
    el.textContent = initials.toUpperCase() || name.slice(0, 2);
  }
  return el;
}

function _renderLink(def) {
  const p = def.props || {};
  const el = document.createElement('a');
  el.className = 'gen-ui-link';
  el.href = p.href || '#';
  el.textContent = p.text || p.href || '';
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  return el;
}

function _renderStat(def) {
  const p = def.props || {};
  const el = document.createElement('div');
  el.className = 'gen-ui-stat';
  const tone = p.tone || 'default';
  if (tone !== 'default') el.classList.add('stat-' + tone);

  const label = document.createElement('div');
  label.className = 'gen-ui-stat-label';
  label.textContent = p.label || '';
  el.appendChild(label);

  const valueRow = document.createElement('div');
  valueRow.className = 'gen-ui-stat-value-row';
  const value = document.createElement('span');
  value.className = 'gen-ui-stat-value';
  value.textContent = p.value != null ? String(p.value) : '';
  valueRow.appendChild(value);
  if (p.unit) {
    const unit = document.createElement('span');
    unit.className = 'gen-ui-stat-unit';
    unit.textContent = p.unit;
    valueRow.appendChild(unit);
  }
  el.appendChild(valueRow);
  return el;
}

function _renderSkeleton(def) {
  const p = def.props || {};
  const variant = p.variant || 'rect';
  const el = document.createElement('div');
  el.className = 'gen-ui-skeleton skeleton-' + variant;
  if (p.width != null) el.style.width = p.width + 'px';
  if (p.height != null) el.style.height = p.height + 'px';
  if (p.rounded || variant === 'circle') el.classList.add('skeleton-rounded');
  return el;
}

function _renderCarousel(def, ctx, visited) {
  const p = def.props || {};
  const loop = p.loop === true;
  const el = document.createElement('div');
  el.className = 'gen-ui-carousel';

  const viewport = document.createElement('div');
  viewport.className = 'gen-ui-carousel-viewport';

  const track = document.createElement('div');
  track.className = 'gen-ui-carousel-track';

  const childIds = def.children || [];
  const childVisited = new Set(visited);
  const slides = [];

  for (const childId of childIds) {
    const childDef = ctx.elements[childId];
    if (!childDef) continue;
    const slide = document.createElement('div');
    slide.className = 'gen-ui-carousel-slide';
    slide.appendChild(_renderElement(childId, childDef, ctx, childVisited));
    track.appendChild(slide);
    slides.push(slide);
  }
  viewport.appendChild(track);
  el.appendChild(viewport);

  if (slides.length > 1) {
    // Keep navigation outside the viewport so it never overlaps slide content.
    const navigation = document.createElement('div');
    navigation.className = 'gen-ui-carousel-navigation';
    const position = document.createElement('span');
    position.className = 'gen-ui-carousel-position';
    position.setAttribute('aria-live', 'polite');

    const controls = document.createElement('div');
    controls.className = 'gen-ui-carousel-controls';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'gen-ui-carousel-btn';
    prevBtn.textContent = '‹';
    prevBtn.setAttribute('aria-label', 'Previous slide');

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'gen-ui-carousel-btn';
    nextBtn.textContent = '›';
    nextBtn.setAttribute('aria-label', 'Next slide');

    let activeIndex = 0;
    const updateNavigation = () => {
      position.textContent = `${activeIndex + 1} / ${slides.length}`;
      prevBtn.disabled = !loop && activeIndex === 0;
      nextBtn.disabled = !loop && activeIndex === slides.length - 1;
    };
    const scroll = (dir) => {
      let next = activeIndex + dir;
      if (loop) {
        if (next < 0) next = slides.length - 1;
        if (next >= slides.length) next = 0;
      } else {
        next = Math.max(0, Math.min(slides.length - 1, next));
      }
      if (next === activeIndex) return;
      activeIndex = next;
      const slideWidth = slides[0]?.offsetWidth || viewport.offsetWidth;
      viewport.scrollTo({ left: activeIndex * slideWidth, behavior: 'smooth' });
      updateNavigation();
    };
    const syncActiveIndex = () => {
      const slideWidth = slides[0]?.offsetWidth || viewport.offsetWidth;
      if (!slideWidth) return;
      activeIndex = Math.max(0, Math.min(slides.length - 1, Math.round(viewport.scrollLeft / slideWidth)));
      updateNavigation();
    };

    prevBtn.addEventListener('click', () => scroll(-1));
    nextBtn.addEventListener('click', () => scroll(1));
    viewport.addEventListener('scroll', syncActiveIndex);
    controls.appendChild(prevBtn);
    controls.appendChild(nextBtn);
    navigation.appendChild(position);
    navigation.appendChild(controls);
    el.appendChild(navigation);
    updateNavigation();
  }

  return el;
}

function _renderTooltip(def) {
  const p = def.props || {};
  const el = document.createElement('span');
  el.className = 'gen-ui-tooltip';
  el.setAttribute('role', 'term');

  const text = document.createElement('span');
  text.className = 'gen-ui-tooltip-text';
  text.textContent = p.text || '';
  el.appendChild(text);

  const tip = document.createElement('span');
  tip.className = 'gen-ui-tooltip-content';
  tip.setAttribute('role', 'definition');
  tip.textContent = p.content || '';
  el.appendChild(tip);

  return el;
}

// ═══════════════════════════════════════════════════════════════
// Chart components (inline SVG, no innerHTML)
// ═══════════════════════════════════════════════════════════════

const _SVG_NS = 'http://www.w3.org/2000/svg';

// 与 generative-ui.css 的 tone 色板同源（accent 与 Progress/Alert 色值一致）。
const _CHART_TONES = [
  { name: 'default', color: '#6391ff' },
  { name: 'success', color: '#22a06b' },
  { name: 'warning', color: '#d98100' },
  { name: 'danger',  color: '#d9363e' },
  { name: 'info',    color: '#356ad2' },
];

function _svgEl(tag, attrs) {
  const el = document.createElementNS(_SVG_NS, tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
  }
  return el;
}

function _svgText(parent, x, y, className, content, anchor) {
  const t = _svgEl('text', { x: x, y: y, 'text-anchor': anchor || 'start', 'class': className });
  t.textContent = content;
  parent.appendChild(t);
}

function _chartToneColor(tone, index) {
  const named = _CHART_TONES.find((t) => t.name === tone);
  return named ? named.color : _CHART_TONES[index % _CHART_TONES.length].color;
}

/** 1/2/5 × 10^n 的"好看"刻度步长。 */
function _niceStep(range) {
  const raw = range / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const normalized = raw / magnitude;
  const factor = normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10;
  return factor * magnitude;
}

function _chartTicks(min, max) {
  if (!(max > min)) return [min];
  const step = _niceStep(max - min);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return ticks;
}

function _formatChartNumber(v) {
  if (Math.abs(v) >= 1e7 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) return v.toExponential(1);
  if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? v.toLocaleString('en-US') : String(v);
  return String(Math.round(v * 100) / 100);
}

// 渐变 id 需在整份文档内唯一（同页多面板、同面板重绘都会叠加），用模块级计数器。
let _guiChartGradSeq = 0;

function _renderChart(def) {
  const p = def.props || {};
  const chartType = p.chartType === 'bar' ? 'bar' : 'line';
  const seriesIn = Array.isArray(p.series) ? p.series : [];
  const labels = Array.isArray(p.labels) ? p.labels.map(String) : [];
  const unit = p.unit ? String(p.unit) : '';

  const el = document.createElement('div');
  el.className = 'gen-ui-chart';

  if (seriesIn.length === 0 || labels.length === 0) {
    el.classList.add('gen-ui-error');
    el.textContent = 'Chart requires series and labels';
    return el;
  }

  // 未声明 tone 的系列按目录色板顺序取色，保证多系列默认可区分。
  const series = seriesIn.map((s, i) => ({
    label: s && typeof s.label === 'string' ? s.label : 'Series ' + (i + 1),
    values: s && Array.isArray(s.values) ? s.values : [],
    color: _chartToneColor(s && typeof s.tone === 'string' ? s.tone : undefined, i),
  }));

  const n = labels.length;
  const showLegend = p.showLegend !== undefined ? p.showLegend === true : series.length > 1;
  const height = Math.max(120, Math.min(600, Number(p.height) || 220));

  // viewBox 宽度 = 容器真实像素宽（首次渲染未知，先用 400 兜底，挂载后重绘），
  // SVG 文字因此恒为真实像素字号，不随容器宽度等比放大。
  const state = { width: 0 };

  const draw = () => {
    const VB_W = Math.min(1000, Math.max(280, Math.round(state.width) || 400));
    const padT = 10, padB = 20, padR = 8;

    // y 域默认包含 0，避免截断坐标轴夸大波动；数据全负时上界取 0。
    let dataMin = Infinity, dataMax = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (typeof v === 'number' && isFinite(v)) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
      }
    }
    if (!isFinite(dataMin)) { dataMin = 0; dataMax = 1; }
    let yMin = typeof p.yMin === 'number' ? p.yMin : Math.min(0, dataMin);
    let yMax = typeof p.yMax === 'number' ? p.yMax : Math.max(0, dataMax);
    if (!(yMax > yMin)) yMax = yMin + 1;
    const ticks = _chartTicks(yMin, yMax);

    // padL 容纳最长的 y 轴刻度文本，长数字不用挤占绘图区。
    const tickTexts = ticks.map(_formatChartNumber);
    const longestTick = tickTexts.reduce((a, b) => (b.length > a.length ? b : a), '');
    const padL = Math.min(76, Math.max(38, Math.round(longestTick.length * 6.4) + 14));
    const plotW = VB_W - padL - padR;
    const plotH = height - padT - padB;
    const xToPx = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yToPx = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    el.textContent = '';

    // 头部行：图例 + 单位（HTML 层，字号不参与 SVG 缩放）。
    if (showLegend || unit) {
      const head = document.createElement('div');
      head.className = 'gen-ui-chart-head';
      if (showLegend) {
        const legend = document.createElement('div');
        legend.className = 'gen-ui-chart-legend';
        for (const s of series) {
          const item = document.createElement('span');
          item.className = 'gen-ui-chart-legend-item';
          const dot = document.createElement('span');
          dot.className = 'gen-ui-chart-legend-dot';
          dot.style.background = s.color;
          item.appendChild(dot);
          item.appendChild(document.createTextNode(s.label));
          legend.appendChild(item);
        }
        head.appendChild(legend);
      }
      if (unit) {
        const unitLabel = document.createElement('span');
        unitLabel.className = 'gen-ui-chart-unit';
        unitLabel.textContent = unit;
        head.appendChild(unitLabel);
      }
      el.appendChild(head);
    }

    const svg = _svgEl('svg', {
      viewBox: `0 0 ${VB_W} ${height}`,
      'class': 'gen-ui-chart-svg',
      role: 'img',
      'aria-label': series.map((s) => s.label).join(', ') + ' ' + chartType + ' chart',
    });

    if (p.showGrid !== false) {
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
      for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        if (tick < yMin || tick > yMax) continue;
        const y = yToPx(tick);
        const isZero = Math.abs(tick) < step * 1e-6;
        svg.appendChild(_svgEl('line', {
          x1: padL, y1: y, x2: VB_W - padR, y2: y,
          'class': isZero || tick === yMin ? 'gen-ui-chart-baseline' : 'gen-ui-chart-grid-line',
        }));
        _svgText(svg, padL - 6, y + 3.5, 'gen-ui-chart-tick', tickTexts[i], 'end');
      }
    }

    // x 轴标签抽稀到至多 8 个，避免窄面板重叠。
    const labelEvery = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelEvery) {
      let text = labels[i];
      if (text.length > 8) text = text.slice(0, 7) + '…';
      const anchor = n === 1 ? 'middle' : (i === 0 ? 'start' : (i + labelEvery >= n ? 'end' : 'middle'));
      _svgText(svg, xToPx(i), height - 6, 'gen-ui-chart-xlabel', text, anchor);
    }

    if (chartType === 'bar') {
      const groupW = plotW / n;
      const innerPad = Math.min(6, groupW * 0.12);
      // 柱宽封顶避免少分组时柱体笨重，封顶后的组内柱排居中。
      const avail = groupW - innerPad * 2;
      const barW = Math.min(avail / series.length, 28);
      const rowOffset = (avail - barW * series.length) / 2;
      const radius = Math.min(3, barW / 3);
      const baselineY = yToPx(Math.max(0, yMin));
      // 同色系垂直微渐变：柱顶全色、柱底渐淡，比纯色填充更有层次且跨主题自然。
      const gradId = 'gen-ui-chart-grad-' + (++_guiChartGradSeq);
      const defs = _svgEl('defs');
      series.forEach((s, gi) => {
        const grad = _svgEl('linearGradient', {
          id: gradId + '-' + gi, x1: 0, y1: 0, x2: 0, y2: 1,
        });
        grad.appendChild(_svgEl('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 1 }));
        grad.appendChild(_svgEl('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.6 }));
        defs.appendChild(grad);
      });
      svg.appendChild(defs);
      for (let si = 0; si < series.length; si++) {
        const s = series[si];
        for (let i = 0; i < n; i++) {
          const v = s.values[i];
          if (typeof v !== 'number' || !isFinite(v)) continue;
          const valueY = yToPx(v);
          const x = padL + groupW * i + innerPad + rowOffset + barW * si;
          const bar = _svgEl('rect', {
            x: x, y: Math.min(baselineY, valueY),
            width: barW, height: Math.max(1, Math.abs(valueY - baselineY)),
            rx: radius, fill: 'url(#' + gradId + '-' + si + ')', 'class': 'gen-ui-chart-bar',
          });
          const title = _svgEl('title');
          title.textContent = `${labels[i]} · ${s.label}: ${_formatChartNumber(v)}${unit ? ' ' + unit : ''}`;
          bar.appendChild(title);
          svg.appendChild(bar);
          if (p.showValues === true && series.length === 1 && n <= 12) {
            _svgText(svg, x + barW / 2, Math.min(baselineY, valueY) - 3, 'gen-ui-chart-value-label', _formatChartNumber(v), 'middle');
          }
        }
      }
    } else {
      for (const s of series) {
        const points = [];
        for (let i = 0; i < n; i++) {
          const v = s.values[i];
          if (typeof v !== 'number' || !isFinite(v)) continue;
          points.push([xToPx(i), yToPx(v), i]);
        }
        if (points.length > 1) {
          svg.appendChild(_svgEl('polyline', {
            points: points.map((pt) => pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' '),
            fill: 'none', stroke: s.color,
            'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }));
        }
        for (const point of points) {
          const dot = _svgEl('circle', { cx: point[0], cy: point[1], r: 2.4, fill: s.color, 'class': 'gen-ui-chart-point' });
          const title = _svgEl('title');
          title.textContent = `${labels[point[2]]} · ${s.label}: ${_formatChartNumber(s.values[point[2]])}${unit ? ' ' + unit : ''}`;
          dot.appendChild(title);
          svg.appendChild(dot);
        }
      }
    }

    el.appendChild(svg);
  };

  draw();

  // 挂载后按容器真实宽度重绘；ResizeObserver 持续跟随面板宽度变化。
  // 沙箱/老环境缺 API 时保留首版 400 兜底绘制。
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver((entries) => {
      const rect = entries && entries[0] && entries[0].contentRect;
      const w = rect && rect.width > 0 ? rect.width : 0;
      if (w > 0 && Math.abs(w - state.width) > 1) {
        state.width = w;
        draw();
      }
    });
    observer.observe(el);
  } else if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      const w = el.clientWidth;
      if (w > 0) {
        state.width = w;
        draw();
      }
    });
  }
  return el;
}

function _renderSparkline(def) {
  const p = def.props || {};
  const values = Array.isArray(p.values) ? p.values.filter((v) => typeof v === 'number' && isFinite(v)) : [];
  const width = Math.max(40, Math.min(2000, Number(p.width) || 120));
  const height = Math.max(16, Math.min(96, Number(p.height) || 32));
  const color = _chartToneColor(typeof p.tone === 'string' ? p.tone : undefined, 0);

  const el = document.createElement('span');
  el.className = 'gen-ui-sparkline';

  const svg = _svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, width: width, height: height,
    'class': 'gen-ui-sparkline-svg', role: 'img',
    'aria-label': `Sparkline, ${values.length} points, last ${values.length ? _formatChartNumber(values[values.length - 1]) : 'n/a'}`,
  });
  el.appendChild(svg);

  if (values.length < 2) {
    // 少于两个点无法构成趋势，保留占位尺寸不渲染线条。
    return el;
  }

  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = max > min ? max - min : 1;
  const pad = 2;
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const line = points.map((pt) => pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ');

  if (p.showArea !== false) {
    svg.appendChild(_svgEl('path', {
      d: `M${points[0][0].toFixed(1)},${height} L${line.replace(/ /g, ' L')} L${points[points.length - 1][0].toFixed(1)},${height} Z`,
      fill: color, 'fill-opacity': 0.13, stroke: 'none',
    }));
  }
  svg.appendChild(_svgEl('polyline', {
    points: line, fill: 'none', stroke: color,
    'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  const last = points[points.length - 1];
  const dot = _svgEl('circle', { cx: last[0], cy: last[1], r: 2, fill: color });
  const title = _svgEl('title');
  title.textContent = `min ${_formatChartNumber(min)} / max ${_formatChartNumber(max)} / last ${_formatChartNumber(values[values.length - 1])}`;
  dot.appendChild(title);
  svg.appendChild(dot);
  return el;
}

// ═══════════════════════════════════════════════════════════════
// Action component
// ═══════════════════════════════════════════════════════════════

function _renderButton(def, ctx) {
  const p = def.props || {};
  const actionId = p.actionId;
  const el = document.createElement('button');
  el.className = 'gen-ui-button';
  const variant = p.variant || 'primary';
  el.classList.add('btn-' + variant);
  el.textContent = p.label || 'Button';
  if (p.disabled) el.disabled = true;

  const action = ctx.actions[actionId];
  el.addEventListener('click', () => {
    if (!action) {
      if (ctx.callbacks.onError) {
        ctx.callbacks.onError('Action not found: ' + actionId);
      }
      return;
    }
    const fields = action.intent === 'submit' ? _collectSubmissionFields(ctx, action) : undefined;
    const execute = () => _executeAction(actionId, action, fields, ctx);
    if (action.confirm) {
      // The renderer owns action dispatch; the host owns the visual dialog.
      // Never silently bypass a declared confirmation when no dialog host is available.
      if (typeof ctx.callbacks.onConfirm === 'function') {
        ctx.callbacks.onConfirm(actionId, action, fields, execute);
      } else if (ctx.callbacks.onError) {
        ctx.callbacks.onError('Confirmation UI is unavailable for action: ' + actionId);
      }
      return;
    }
    execute();
  });
  return el;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function _wrapWithLabel(labelText, required) {
  const wrap = document.createElement('div');
  wrap.className = 'gen-ui-field';
  if (labelText) {
    const label = document.createElement('label');
    label.className = 'gen-ui-field-label';
    label.textContent = labelText + (required ? ' *' : '');
    wrap.appendChild(label);
  }
  return wrap;
}

function _getCurrentFieldValue(ctx, name) {
  if (name && Object.prototype.hasOwnProperty.call(ctx.viewState, name)) {
    return ctx.viewState[name];
  }
  return name ? ctx.initialValues[name] : undefined;
}

function _collectSubmissionFields(ctx, action) {
  const names = Array.isArray(action.includeFields)
    ? action.includeFields
    : [...ctx.fieldReaders.keys()];
  const fields = {};

  for (const name of names) {
    const readValue = ctx.fieldReaders.get(name);
    if (readValue) fields[name] = readValue();
  }
  return fields;
}

function _executeAction(actionId, action, fields, ctx) {
  if (action.intent === 'reset') {
    if (ctx.callbacks.onReset) ctx.callbacks.onReset(actionId, action);
    return;
  }
  if (ctx.callbacks.onSubmit) ctx.callbacks.onSubmit(actionId, action, fields || {});
}

function _gapToCss(gap) {
  const map = { xs: '4px', sm: '8px', md: '12px', lg: '16px' };
  return map[gap] || '12px';
}

function _alignToCss(align) {
  const map = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
  return map[align] || 'stretch';
}

// ═══════════════════════════════════════════════════════════════
// Component handler registry
// ═══════════════════════════════════════════════════════════════

const _COMPONENT_HANDLERS = {
  Stack:       _renderStack,
  Row:         _genUiRenderRow,
  Grid:        _renderGrid,
  Card:        _renderCard,
  Divider:     _renderDivider,
  Text:        _renderText,
  Badge:       _renderBadge,
  Table:       _renderTable,
  Alert:       _renderAlert,
  Progress:    _renderProgress,
  CodeBlock:   _renderCodeBlock,
  TextInput:   _renderTextInput,
  NumberInput: _renderNumberInput,
  Textarea:    _renderTextarea,
  Select:      _renderSelect,
  Checkbox:    _renderCheckbox,
  RadioGroup:  _renderRadioGroup,
  DateInput:   _renderDateInput,
  Slider:      _renderSlider,
  Switch:      _renderSwitch,
  SegmentedControl: _renderSegmentedControl,
  Button:      _renderButton,
  // Navigation / collapsible
  Tabs:        _renderTabs,
  Accordion:   _renderAccordion,
  // Extended display
  Steps:       _renderSteps,
  Spinner:     _renderSpinner,
  Image:       _renderImage,
  Avatar:      _renderAvatar,
  Link:        _renderLink,
  Stat:        _renderStat,
  Skeleton:    _renderSkeleton,
  Carousel:    _renderCarousel,
  Tooltip:     _renderTooltip,
  Chart:       _renderChart,
  Sparkline:   _renderSparkline,
};

// ═══════════════════════════════════════════════════════════════
// Global exports
// ═══════════════════════════════════════════════════════════════

window.renderGenUISpec = renderGenUISpec;
window.createGenUIViewState = createGenUIViewState;
