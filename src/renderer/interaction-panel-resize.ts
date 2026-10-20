import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const DEFAULT_WIDTH = 570;
const MIN_PANEL_WIDTH = 350;
const MIN_CHAT_WIDTH = 320;
const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));

export function useInteractionPanelResize(active: boolean) {
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number; handle: HTMLButtonElement } | undefined>(undefined);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_WIDTH);
  const [limits, setLimits] = useState({ min: MIN_PANEL_WIDTH, max: DEFAULT_WIDTH });
  const [dragging, setDragging] = useState(false);
  const width = clamp(preferredWidth, limits.min, limits.max);

  useLayoutEffect(() => {
    const element = shell.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const main = parent.querySelector<HTMLElement>(':scope > .main-content');
    const measure = () => {
      // Count only the two panes: navigation and any file inspector keep their space.
      const available = main
        ? main.getBoundingClientRect().width + element.getBoundingClientRect().width
        : parent.getBoundingClientRect().width;
      if (available <= 0) return;
      const max = Math.max(0, Math.floor(available - Math.min(MIN_CHAT_WIDTH, available / 2)));
      const min = Math.min(MIN_PANEL_WIDTH, max);
      setLimits(current => current.min === min && current.max === max ? current : { min, max });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (main) observer.observe(main);
    return () => observer.disconnect();
  }, [active]);

  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    document.body.classList.remove('interaction-resizing');
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setDragging(false);
  };
  useEffect(() => {
    if (!active) finish();
    return finish;
  }, [active]);

  const resize = (next: number) => setPreferredWidth(clamp(next, limits.min, limits.max));
  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    if (!active || event.button !== 0 || !event.isPrimary || !shell.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: shell.current.getBoundingClientRect().width, handle: event.currentTarget };
    document.body.classList.add('interaction-resizing');
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current && current.pointerId === event.pointerId) resize(current.width + current.x - event.clientX);
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId === event.pointerId) finish();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resize(event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : width + (event.key === 'ArrowLeft' ? 24 : -24));
  };
  return { shell, width, limits, dragging, begin, move, end, keyDown };
}
