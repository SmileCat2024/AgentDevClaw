/**
 * i18n 域（P4 T1 原料层）：字典 / 翻译函数 / 桥键契约。
 *
 * 迁移前 i18n.js 是 classic script：`const I18N` + `function t`，语言靠裸读全局
 * `currentLanguage`。迁移后实现是 ESM，classic 消费方经桥键 `t` 继续裸读。
 * 本文件钉住三件对外承诺：
 *   1. 翻译结果由真实字典决定，缺键回退键名；
 *   2. 语言读取是实时的（切换语言后同一个 t 立刻给出新语言文案）；
 *   3. i18n-host 装载后 `window.t` 与模块导出一致，classic 写方覆盖经 claim 转发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, I18N } from '../public/src/i18n.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

test('翻译取自真实字典，缺键回退键名', () => {
  const zh = createTranslator(() => 'zh');
  const en = createTranslator(() => 'en');
  assert.equal(zh('page_title'), I18N.zh.page_title);
  assert.equal(en('page_title'), I18N.en.page_title);
  assert.notEqual(I18N.zh.page_title, I18N.en.page_title, '样例键必须两种语言不同，否则下面分辨不了语言');
  assert.equal(zh('__missing_key__'), '__missing_key__');
});

test('未知语言回退中文表；语言读取实时生效', () => {
  let language = 'fr';
  const t = createTranslator(() => language);
  assert.equal(t('page_title'), I18N.zh.page_title, '未支持的语言回退到 zh 表');
  language = 'en';
  assert.equal(t('page_title'), I18N.en.page_title, '同一个 t 换语言后立即生效');
});

test('i18n-host：window.t 与模块实现同源，classic 覆盖经 claim 转发', async () => {
  await withP2EsmCase({
    classic: (sandbox) => { sandbox.currentLanguage = 'zh'; },
    globals: {},
  }, async (c) => {
    await c.load('public/src/modules/i18n-host.js');
    assert.equal(c.read('window.t("page_title")'), I18N.zh.page_title);
    c.window.currentLanguage = 'en';
    assert.equal(c.read('window.t("page_title")'), I18N.en.page_title, '桥键读方实时跟随 currentLanguage');
    // classic 写方（如测试替身或旧调用链覆盖 t）经 setter 进域状态，读方拿到新值
    c.read('window.t = () => "overridden"');
    assert.equal(c.read('window.t()'), 'overridden');
  });
});
