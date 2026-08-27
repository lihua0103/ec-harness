// === 完整的品牌UI诊断脚本 ===
console.log('=== 品牌配置诊断 ===');
console.log('1. 品牌全局变量:', window.__DSH_ENTERPRISE_BRAND__);
console.log('2. document.title:', document.title);

console.log('\n=== CSS 样式诊断 ===');
const brandCss = document.getElementById('brand-logo-css');
console.log('3. 品牌CSS存在:', !!brandCss);
if (brandCss) console.log('   CSS内容:', brandCss.textContent);

console.log('\n=== Logo区域诊断 ===');
const logoRow = document.querySelector('div[class*="logoRow"]');
console.log('4. logoRow存在:', !!logoRow);
const brandBtn = document.querySelector('div[class*="logoRow"] > button[class*="brand"]');
console.log('5. 品牌按钮存在:', !!brandBtn);
if (brandBtn) {
  console.log('   按钮HTML:', brandBtn.innerHTML.substring(0, 200));
  console.log('   data-brand-logo存在:', !!brandBtn.querySelector('[data-brand-logo]'));
}

console.log('\n=== 侧边栏金鱼诊断 ===');
const fish = document.querySelector('svg[class*="railFish"]');
console.log('6. SVG金鱼存在:', !!fish);
if (fish) {
  console.log('   金鱼class:', fish.getAttribute('class'));
  console.log('   金鱼computed display:', getComputedStyle(fish).display);
}
const railImg = document.querySelector('img[data-brand-fish]');
console.log('7. 品牌替换图标存在:', !!railImg);
if (railImg) {
  console.log('   图标src:', railImg.src);
}

console.log('\n=== 所有可能的DeepSeek标记 ===');
const allText = document.body.innerText;
const deepseekMatches = allText.match(/DeepSeek/gi) || [];
const dshMatches = allText.match(/\bDSH\b/g) || [];
console.log('8. 页面中"DeepSeek"出现次数:', deepseekMatches.length);
console.log('9. 页面中"DSH"出现次数:', dshMatches.length);
