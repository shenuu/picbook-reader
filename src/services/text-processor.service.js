/**
 * @file services/text-processor.service.js
 * @description 绘本朗读助手 - 文本预处理服务
 *
 * 职责：
 *  1. 语种检测（中文 / 英文 / 混合）
 *  2. 文本清洗：OCR 常见噪声修正、标点规范化
 *  3. 英文单词修复：处理 OCR 粘连、大小写修正
 *  4. 分段限制：讯飞 TTS 单次上限 8000 字节，超长自动截断并打 warning
 *
 * @author Jamie Park
 * @version 1.0.0
 */

// ─────────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────────

/** 讯飞 TTS 单次最大文本字节数 */
const TTS_MAX_BYTES = 8000;

/** 英文字符（含数字、标点）占比阈值，超过此值判为"英文为主" */
const ENGLISH_DOMINANT_RATIO = 0.5;

/** 混合语种阈值：英文占比超过此值才提示 */
const ENGLISH_MIXED_RATIO = 0.15;

// ─────────────────────────────────────────────────────────────────
//  语种检测
// ─────────────────────────────────────────────────────────────────

/**
 * 检测文本的语种分布
 *
 * @param {string} text
 * @returns {{ type: 'chinese'|'english'|'mixed', englishRatio: number, chineseRatio: number }}
 */
function detectLanguage(text) {
  if (!text || text.length === 0) {
    return { type: 'chinese', englishRatio: 0, chineseRatio: 0 };
  }

  // 去掉空白和标点再统计
  const cleaned = text.replace(/[\s\u3000\u00A0]/g, '');
  if (cleaned.length === 0) {
    return { type: 'chinese', englishRatio: 0, chineseRatio: 0 };
  }

  let chineseCount = 0;
  let englishCount = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    // 中文 CJK 统一汉字区
    if (code >= 0x4E00 && code <= 0x9FFF) {
      chineseCount++;
    } else if (
      // 英文字母 a-z A-Z
      (code >= 0x41 && code <= 0x5A) ||
      (code >= 0x61 && code <= 0x7A)
    ) {
      englishCount++;
    }
  }

  const total = chineseCount + englishCount;
  if (total === 0) {
    return { type: 'chinese', englishRatio: 0, chineseRatio: 0 };
  }

  const englishRatio = englishCount / total;
  const chineseRatio = chineseCount / total;

  let type;
  if (englishRatio >= ENGLISH_DOMINANT_RATIO) {
    type = 'english';
  } else if (englishRatio >= ENGLISH_MIXED_RATIO) {
    type = 'mixed';
  } else {
    type = 'chinese';
  }

  return { type, englishRatio, chineseRatio };
}

// ─────────────────────────────────────────────────────────────────
//  OCR 噪声清洗
// ─────────────────────────────────────────────────────────────────

/**
 * 清洗 OCR 识别文本中的常见噪声
 *
 * @param {string} text
 * @returns {string}
 */
function cleanOcrNoise(text) {
  if (!text) return '';

  let result = text;

  // 1. 去掉行尾多余空格、制表符
  result = result.replace(/[ \t]+$/gm, '');

  // 2. 多个连续空行合并为一个
  result = result.replace(/\n{3,}/g, '\n\n');

  // 3. 合并句中断行：前一行末尾没有句末标点时，去掉换行符拼接到下一行
  //    "小熊看着\n天空" → "小熊看着天空"
  //    "你好。\n新段落" → 保留（句末标点后保持段落分隔）
  //    双换行（段落间隔）始终保留
  result = result.replace(/([^。！？…\r\n])\n(?!\n)/g, '$1');

  // 3. 中文标点前后的多余空格（如 "你好 ，" → "你好，"）
  result = result.replace(/\s+([，。！？；：""''【】（）])/g, '$1');
  result = result.replace(/([，。！？；：""''【】（）])\s+/g, '$1');

  // 4. OCR 常见误识：把"0"误识为"O"、"1"误识为"l"——在纯英文单词中修正
  // （不处理中文语境，避免误改）
  // 例如 "l0ve" → 注意：这里保守处理，只做简单替换
  // result = result.replace(/\bl([0-9])/g, '1$1'); // l后跟数字才替换

  // 5. 英文单词间如果没有空格但有大写字母相连，尝试分词
  //    如 "TheCat" → "The Cat"（OCR 行拼接丢失空格）
  result = result.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 6. 数字与英文字母粘连（如 "3cats" → "3 cats"，"cats3" → "cats 3"）
  result = result.replace(/(\d)([A-Za-z])/g, '$1 $2');
  result = result.replace(/([A-Za-z])(\d)/g, '$1 $2');

  // 7. 去掉无意义的孤立特殊符号（OCR 背景噪声）
  result = result.replace(/^[|\\/_\-~`]+$/gm, '');

  // 8. 首尾空白
  result = result.trim();

  return result;
}

// ─────────────────────────────────────────────────────────────────
//  英文文本优化
// ─────────────────────────────────────────────────────────────────

/**
 * 针对英文/混合文本做额外优化，改善讯飞 TTS 朗读效果
 *
 * @param {string} text
 * @returns {string}
 */
function enhanceEnglishText(text) {
  if (!text) return '';

  let result = text;

  // 1. 修复句首字母小写（讯飞 TTS 对句首大写读音更自然）
  //    只在句号/感叹号/问号后的第一个英文字母大写
  result = result.replace(/([.!?]\s+)([a-z])/g, (_, punc, letter) => {
    return punc + letter.toUpperCase();
  });

  // 2. 全文第一个英文字母大写
  result = result.replace(/^([a-z])/, (letter) => letter.toUpperCase());

  // 3. "i" 单词大写 → "I"（只有前后是空格/标点时才替换）
  result = result.replace(/\bi\b/g, 'I');

  // 4. 缩写修正：常见 OCR 误识
  //    "dont" → "don't"，"cant" → "can't" 等（保守，只处理常见几个）
  const contractionMap = {
    'dont': "don't",
    'cant': "can't",
    'wont': "won't",
    'isnt': "isn't",
    'arent': "aren't",
    'wasnt': "wasn't",
    'werent': "weren't",
    'hasnt': "hasn't",
    'havent': "haven't",
    'hadnt': "hadn't",
    'didnt': "didn't",
    'doesnt': "doesn't",
    'wouldnt': "wouldn't",
    'couldnt': "couldn't",
    'shouldnt': "shouldn't",
    'im': "I'm",
    'ive': "I've",
    'id': "I'd",
    'ill': "I'll",
    'youre': "you're",
    'youve': "you've",
    'youll': "you'll",
    'theyre': "they're",
    'theyve': "they've",
    'theyll': "they'll",
    'hes': "he's",
    'shes': "she's",
    'its': "it's",
    'weve': "we've",
    'were': "we're",
  };

  Object.entries(contractionMap).forEach(([wrong, correct]) => {
    // 只替换完整单词（word boundary）
    const re = new RegExp(`\\b${wrong}\\b`, 'gi');
    result = result.replace(re, (match) => {
      // 保持原始大小写风格
      if (match === match.toUpperCase()) return correct.toUpperCase();
      if (match[0] === match[0].toUpperCase()) {
        return correct.charAt(0).toUpperCase() + correct.slice(1);
      }
      return correct;
    });
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────
//  字节长度截断
// ─────────────────────────────────────────────────────────────────

/**
 * 将文本截断到讯飞 TTS 允许的最大字节数（UTF-8）
 * 避免因文本过长导致合成失败
 *
 * @param {string} text
 * @param {number} [maxBytes=TTS_MAX_BYTES]
 * @returns {string}
 */
function truncateToTtsLimit(text, maxBytes = TTS_MAX_BYTES) {
  // 先估算：如果长度 * 3 < maxBytes，肯定没超
  if (text.length * 3 <= maxBytes) return text;

  // 精确计算 UTF-8 字节数
  let byteCount = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) byteCount += 1;
    else if (code < 0x800) byteCount += 2;
    else byteCount += 3;

    if (byteCount > maxBytes) {
      console.warn(`[TextProcessor] 文本超出 TTS 限制 ${maxBytes} 字节，已在第 ${i} 字符处截断`);
      return text.slice(0, i);
    }
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────

/**
 * 对 OCR 识别的原始文本做完整预处理，优化 TTS 朗读效果
 *
 * 流程：OCR噪声清洗 → 语种检测 → 英文优化（按需）→ 字节截断
 *
 * @param {string} rawText - OCR 识别的原始文本
 * @returns {{ processedText: string, language: object, truncated: boolean }}
 *   - processedText: 处理后的文本
 *   - language: { type, englishRatio, chineseRatio }
 *   - truncated: 是否因超长被截断
 */
function processForTts(rawText) {
  if (!rawText || rawText.trim() === '') {
    return {
      processedText: '',
      language: { type: 'chinese', englishRatio: 0, chineseRatio: 0 },
      truncated: false,
    };
  }

  // Step 1: OCR 噪声清洗
  let text = cleanOcrNoise(rawText);

  // Step 2: 语种检测
  const language = detectLanguage(text);

  // Step 3: 英文/混合文本增强
  if (language.type === 'english' || language.type === 'mixed') {
    text = enhanceEnglishText(text);
  }

  // Step 4: 截断到 TTS 限制
  const before = text;
  text = truncateToTtsLimit(text);
  const truncated = text !== before;

  return { processedText: text, language, truncated };
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  processForTts,
  detectLanguage,
  cleanOcrNoise,
  enhanceEnglishText,
  truncateToTtsLimit,
};
