import React from 'react';

/** CheckQ 标志：白色勾 + Q 尾点。颜色走品牌 token，明暗主题共用。 */
export function BrandMark({ size = 22, className = '' }) {
  return (
    <svg
      className={`brand-mark${className ? ` ${className}` : ''}`}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="9" fill="var(--brand-mark-bg)" />
      <path d="M8 16.2l4.4 4.4 8.4-9.8" fill="none" stroke="var(--brand-mark-fg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24.2" cy="23.2" r="2.4" fill="var(--brand-mark-dot)" />
    </svg>
  );
}

/** 横向品牌组合：图形 + 字标。字标只出现一次，避免页面里重复拼写品牌。 */
export default function Logo({ size = 22, wordSize = 15, className = '', showWord = true }) {
  return (
    <span className={`brand-logo${className ? ` ${className}` : ''}`} role="img" aria-label="CheckQ">
      <BrandMark size={size} />
      {showWord ? (
        <span className="brand-word" style={wordSize ? { fontSize: wordSize } : undefined}>
          Check<em>Q</em>
        </span>
      ) : null}
    </span>
  );
}
