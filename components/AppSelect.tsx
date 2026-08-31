import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type AppSelectSize = 'compact' | 'medium' | 'large';

type AppSelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size' | 'onClick'> & {
  /** Spacing and popup dimensions; the parent remains in control of field width. */
  size?: AppSelectSize;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
};

type MenuOption = { value: string; label: string; disabled: boolean; hidden: boolean; group: string };
type MenuPosition = { top: number; left: number; width: number; maxHeight: number; direction: 'rtl' | 'ltr' };

const MENU_DIMENSIONS: Record<AppSelectSize, { minWidth: number; maxHeight: number; gap: number }> = {
  compact: { minWidth: 136, maxHeight: 208, gap: 4 },
  medium: { minWidth: 200, maxHeight: 240, gap: 8 },
  large: { minWidth: 240, maxHeight: 320, gap: 8 },
};

/** Shared single-choice menu. The native control retains form values and real change events. */
const AppSelect: React.FC<AppSelectProps> = ({
  children, className = '', id, style, title, dir, disabled, required, autoFocus, tabIndex, size = 'medium',
  onClick, onChange, onInvalid, ...nativeProps
}) => {
  const generatedId = useId();
  const triggerId = id || `app-select-${generatedId}`;
  const listId = `${triggerId}-options`;
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<MenuOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [label, setLabel] = useState<string | undefined>();
  const [validationMessage, setValidationMessage] = useState('');

  // Reading native options also supports fragments, conditional options and optgroups.
  useLayoutEffect(() => {
    const select = nativeRef.current;
    if (!select) return;
    setOptions(Array.from(select.options, option => ({
      value: option.value,
      label: option.label,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      hidden: option.hidden || Boolean(option.closest('optgroup[hidden]')),
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
    })));
  }, [children, nativeProps.value, nativeProps.defaultValue]);

  useLayoutEffect(() => {
    // React may restore a controlled value when its owner declines a change.
    setSelectedIndex(nativeRef.current?.selectedIndex ?? -1);
    if (validationMessage && nativeRef.current?.validity.valid) setValidationMessage('');
  });

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger || nativeProps['aria-label'] || nativeProps['aria-labelledby']) return;
    // Existing inline labels keep their association; also support labels preceding the field.
    if (trigger.labels?.length) return;
    const preceding = nativeRef.current?.previousElementSibling;
    if (preceding?.tagName === 'LABEL') setLabel(preceding.textContent?.trim() || title);
    else setLabel(title);
  }, [title, nativeProps['aria-label'], nativeProps['aria-labelledby']]);

  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const active = options[activeIndex];
    if (!active || active.disabled || active.hidden) {
      setActiveIndex(options.findIndex(option => !option.disabled && !option.hidden));
    }
  }, [open, options, activeIndex]);

  useLayoutEffect(() => {
    const form = nativeRef.current?.form;
    if (!form) return;
    let frame = 0;
    const reset = () => {
      setOpen(false);
      setValidationMessage('');
      frame = requestAnimationFrame(() => setSelectedIndex(nativeRef.current?.selectedIndex ?? -1));
    };
    form.addEventListener('reset', reset);
    return () => { form.removeEventListener('reset', reset); cancelAnimationFrame(frame); };
  }, [nativeProps.form]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const reposition = () => {
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || document.documentElement.clientWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const edge = 8;
      const { gap, minWidth, maxHeight: sizeMaxHeight } = MENU_DIMENSIONS[size];
      const below = viewportTop + viewportHeight - rect.bottom - edge - gap;
      const above = rect.top - viewportTop - edge - gap;
      const height = Math.min(menuRef.current?.scrollHeight || sizeMaxHeight, sizeMaxHeight);
      const upwards = below < height && above > below;
      const maxHeight = Math.max(0, Math.min(sizeMaxHeight, upwards ? above : below));
      const width = Math.max(0, Math.min(Math.max(rect.width, minWidth), viewportWidth - edge * 2));
      const direction = getComputedStyle(trigger).direction === 'rtl' ? 'rtl' : 'ltr';
      const left = Math.max(viewportLeft + edge, Math.min(direction === 'rtl' ? rect.right - width : rect.left, viewportLeft + viewportWidth - width - edge));
      setPosition({
        top: upwards ? Math.max(viewportTop + edge, rect.top - gap - Math.min(height, maxHeight)) : rect.bottom + gap,
        left, width, maxHeight, direction,
      });
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) reposition();
    };
    const dismissOutside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(trigger);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open, size, options]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const enabledIndices = options.flatMap((option, index) => option.disabled || option.hidden ? [] : [index]);
  const showMenu = (last = false) => {
    if (disabled) return;
    setActiveIndex(enabledIndices.includes(selectedIndex) ? selectedIndex : (last ? enabledIndices.at(-1) : enabledIndices[0]) ?? -1);
    searchRef.current = { text: '', time: 0 };
    setPosition(null);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    const select = nativeRef.current;
    if (!select || !option || option.disabled || option.hidden || disabled) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (key === 'Tab') { setOpen(false); return; }
    if (key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (key === 'Enter' || (key === ' ' && Date.now() - searchRef.current.time > 700)) {
      event.preventDefault();
      event.stopPropagation();
      if (open) choose(activeIndex); else showMenu();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) showMenu(key === 'ArrowUp' || key === 'End');
      if (key === 'Home') setActiveIndex(enabledIndices[0] ?? -1);
      else if (key === 'End') setActiveIndex(enabledIndices.at(-1) ?? -1);
      else if (open) {
        const current = enabledIndices.indexOf(activeIndex);
        const next = Math.max(0, Math.min(enabledIndices.length - 1, current + (key === 'ArrowDown' ? 1 : -1)));
        setActiveIndex(enabledIndices[next] ?? -1);
      }
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const search = now - searchRef.current.time > 700 ? key : searchRef.current.text + key;
      const repeated = Array.from(search).every(character => character === key);
      const query = (repeated ? key : search).toLocaleLowerCase();
      const current = open ? activeIndex : selectedIndex;
      const start = Math.max(0, enabledIndices.indexOf(current) + (query.length === 1 ? 1 : 0));
      const ordered = [...enabledIndices.slice(start), ...enabledIndices.slice(0, start)];
      const match = ordered.find(index => options[index].label.trim().toLocaleLowerCase().startsWith(query));
      if (!open) showMenu();
      searchRef.current = { text: search, time: now };
      if (match !== undefined) setActiveIndex(match);
    }
  };

  const attributes = Object.fromEntries(Object.entries(nativeProps).filter(([key]) => key.startsWith('aria-') || key.startsWith('data-')));
  const formProps = Object.fromEntries(Object.entries(nativeProps).filter(([key]) => !key.startsWith('aria-') && !key.startsWith('data-')));

  return (
    <>
      <select
        {...formProps}
        ref={nativeRef}
        id={`${triggerId}-native`}
        className="app-select-native"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        required={required}
        onFocus={() => triggerRef.current?.focus()}
        onInvalid={event => {
          onInvalid?.(event);
          event.preventDefault();
          setValidationMessage(event.currentTarget.validationMessage);
          triggerRef.current?.focus();
        }}
        onChange={event => {
          setSelectedIndex(event.currentTarget.selectedIndex);
          setValidationMessage('');
          onChange?.(event);
        }}
      >{children}</select>
      <button
        {...attributes}
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-label={nativeProps['aria-label'] || label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-required={required || undefined}
        aria-invalid={validationMessage ? true : nativeProps['aria-invalid']}
        aria-describedby={[nativeProps['aria-describedby'], validationMessage ? `${triggerId}-error` : ''].filter(Boolean).join(' ') || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        title={title}
        dir={dir}
        data-menu-size={size}
        style={style}
        className={`app-select-trigger ${className}`}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
        onClick={event => {
          onClick?.(event);
          if (!event.defaultPrevented) { if (open) setOpen(false); else showMenu(); }
        }}
      >
        <span className="app-select-label">{options[selectedIndex]?.label || '\u00a0'}</span>
        <ChevronDown size={14} className="app-select-chevron" aria-hidden="true" />
      </button>
      {validationMessage && <span id={`${triggerId}-error`} role="alert" className="sr-only">{validationMessage}</span>}
      {open && !disabled && createPortal(
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={nativeProps['aria-label'] || label}
          aria-labelledby={nativeProps['aria-labelledby'] || (!nativeProps['aria-label'] && !label ? triggerId : undefined)}
          dir={position?.direction || dir}
          data-menu-size={size}
          className="editor-menu app-select-menu custom-scrollbar"
          style={position ? { ...position, visibility: 'visible' } : { visibility: 'hidden' }}
          onMouseDown={event => event.preventDefault()}
          onClick={event => event.stopPropagation()}
        >
          {options.map((option, index) => !option.hidden && (
            <React.Fragment key={`${index}-${option.value}`}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div className="editor-menu-group" role="presentation">{option.group}</div>
              )}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                data-active={index === activeIndex}
                className="editor-menu-item app-select-option"
                onPointerMove={event => { if (event.pointerType === 'mouse' && !option.disabled) setActiveIndex(index); }}
                onClick={() => choose(index)}
              >
                <span className="app-select-option-label">{option.label}</span>
                <Check size={size === 'compact' ? 12 : 14} aria-hidden="true" className={index === selectedIndex ? 'shrink-0' : 'invisible shrink-0'} />
              </div>
            </React.Fragment>
          ))}
        </div>, document.body,
      )}
    </>
  );
};

export default AppSelect;
