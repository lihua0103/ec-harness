export function redactSensitiveText(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    // 本地路径（Windows 盘符 / UNC / Unix 绝对路径）不得进入错误回执。
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[PATH]')
    .replace(/\\\\[^\s"']+/g, '[PATH]')
    .replace(/(^|[\s"'(=])((?:\/[\w.-]+){2,})/g, '$1[PATH]')
    .replace(/\b[A-Za-z]{1,4}\d{6,8}\b/g, '[SUBJ]')
    .replace(/\b\d{3,4}-\d{3,6}\b/g, '[SUBJ]')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?\b/g, '[DATE]')
    .slice(0, 120);
}
