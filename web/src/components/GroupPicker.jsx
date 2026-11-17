import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronDown } from './Icons.jsx';

/**
 * 分组选择：可以手填新名字，也能点开选已有分组。
 * 原生 datalist 在弹窗里没有可见的展开按钮，用户不知道能选；这里给明确的按钮 + 列表。
 */
export default function GroupPicker({ value, onChange, groups = [], ariaLabel = '任务分组', placeholder = '选已有分组或输入新名字', inputId }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const options = useMemo(() => {
    const q = String(value || '').trim().toLowerCase();
    return (groups || [])
      .filter(Boolean)
      .filter((g) => !q || g.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  }, [groups, value]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (g) => { onChange(g); setOpen(false); };

  return (
    <div className="group-picker" ref={wrapRef}>
      <div className="group-picker-row">
        <input
          id={inputId}
          value={value}
          aria-label={ariaLabel}
          aria-expanded={open}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
        />
        <button
          type="button"
          className={`group-picker-btn${open ? ' open' : ''}`}
          aria-label={open ? '收起分组列表' : '展开分组列表'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div className="group-list" role="listbox" aria-label="已有分组">
          {options.length === 0 && (
            <div className="group-empty">{groups.length ? '没有匹配的分组' : '还没有分组，直接输入即新建'}</div>
          )}
          {options.map((g) => (
            <button
              type="button"
              key={g}
              role="option"
              aria-selected={g === value}
              className={g === value ? 'is-current' : ''}
              onClick={() => pick(g)}
            >
              <span className="group-list-name">{g}</span>
            </button>
          ))}
          {value ? (
            <button type="button" className="group-clear" onClick={() => pick('')}>清空（不分组）</button>
          ) : null}
        </div>
      )}
    </div>
  );
}
