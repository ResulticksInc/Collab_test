export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'left-start' | 'left-end' | 'right-start' | 'right-end';

export interface PositionResult {
  top: number;
  left: number;
  placement: Placement;
  arrowPosition?: { top?: number; left?: number; right?: number; bottom?: number };
}

export interface PositionOptions {
  triggerRect: DOMRect;
  contentRect: DOMRect;
  placement?: Placement;
  offset?: number;
  padding?: number;
  boundary?: DOMRect | 'viewport';
  flip?: boolean;
  shift?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<PositionOptions, 'triggerRect' | 'contentRect'>> = {
  placement: 'bottom',
  offset: 8,
  padding: 8,
  boundary: 'viewport',
  flip: true,
  shift: true,
};

function getBoundaryRect(boundary: DOMRect | 'viewport'): DOMRect {
  if (boundary === 'viewport') {
    return {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }
  return boundary;
}

function getPlacementCoords(
  triggerRect: DOMRect,
  contentRect: DOMRect,
  placement: Placement,
  offset: number
): { top: number; left: number; arrowPosition?: PositionResult['arrowPosition'] } {
  const { top, left, right, bottom, width, height } = triggerRect;
  const cw = contentRect.width;
  const ch = contentRect.height;

  switch (placement) {
    case 'top':
      return {
        top: top - ch - offset,
        left: left + width / 2 - cw / 2,
        arrowPosition: { bottom: -4, left: cw / 2 - 4 },
      };
    case 'bottom':
      return {
        top: bottom + offset,
        left: left + width / 2 - cw / 2,
        arrowPosition: { top: -4, left: cw / 2 - 4 },
      };
    case 'left':
      return {
        top: top + height / 2 - ch / 2,
        left: left - cw - offset,
        arrowPosition: { right: -4, top: ch / 2 - 4 },
      };
    case 'right':
      return {
        top: top + height / 2 - ch / 2,
        left: right + offset,
        arrowPosition: { left: -4, top: ch / 2 - 4 },
      };
    case 'top-start':
      return {
        top: top - ch - offset,
        left: left,
        arrowPosition: { bottom: -4, left: 12 },
      };
    case 'top-end':
      return {
        top: top - ch - offset,
        left: right - cw,
        arrowPosition: { bottom: -4, right: 12 },
      };
    case 'bottom-start':
      return {
        top: bottom + offset,
        left: left,
        arrowPosition: { top: -4, left: 12 },
      };
    case 'bottom-end':
      return {
        top: bottom + offset,
        left: right - cw,
        arrowPosition: { top: -4, right: 12 },
      };
    case 'left-start':
      return {
        top: top,
        left: left - cw - offset,
        arrowPosition: { right: -4, top: 12 },
      };
    case 'left-end':
      return {
        top: bottom - ch,
        left: left - cw - offset,
        arrowPosition: { right: -4, bottom: 12 },
      };
    case 'right-start':
      return {
        top: top,
        left: right + offset,
        arrowPosition: { left: -4, top: 12 },
      };
    case 'right-end':
      return {
        top: bottom - ch,
        left: right + offset,
        arrowPosition: { left: -4, bottom: 12 },
      };
    default:
      return { top: bottom + offset, left: left + width / 2 - cw / 2 };
  }
}

function isOverflowing(
  coords: { top: number; left: number },
  contentRect: DOMRect,
  boundary: DOMRect,
  padding: number
): { horizontal: boolean; vertical: boolean } {
  return {
    horizontal: coords.left < boundary.left + padding || coords.left + contentRect.width > boundary.right - padding,
    vertical: coords.top < boundary.top + padding || coords.top + contentRect.height > boundary.bottom - padding,
  };
}

function flipPlacement(placement: Placement, overflow: { horizontal: boolean; vertical: boolean }): Placement {
  if (overflow.vertical) {
    if (placement.startsWith('top')) return placement.replace('top', 'bottom') as Placement;
    if (placement.startsWith('bottom')) return placement.replace('bottom', 'top') as Placement;
  }
  if (overflow.horizontal) {
    if (placement.startsWith('left')) return placement.replace('left', 'right') as Placement;
    if (placement.startsWith('right')) return placement.replace('right', 'left') as Placement;
  }
  return placement;
}

function shiftPlacement(
  coords: { top: number; left: number },
  contentRect: DOMRect,
  boundary: DOMRect,
  padding: number
): { top: number; left: number } {
  let { top, left } = coords;

  if (left < boundary.left + padding) left = boundary.left + padding;
  if (left + contentRect.width > boundary.right - padding) left = boundary.right - padding - contentRect.width;
  if (top < boundary.top + padding) top = boundary.top + padding;
  if (top + contentRect.height > boundary.bottom - padding) top = boundary.bottom - padding - contentRect.height;

  return { top, left };
}

export function calculatePosition(options: PositionOptions): PositionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const boundary = getBoundaryRect(opts.boundary);
  const { triggerRect, contentRect, placement, offset, padding, flip, shift } = opts;

  let currentPlacement = placement;
  let coords = getPlacementCoords(triggerRect, contentRect, currentPlacement, offset);
  let overflow = isOverflowing(coords, contentRect, boundary, padding);

  if (flip && (overflow.horizontal || overflow.vertical)) {
    const flipped = flipPlacement(currentPlacement, overflow);
    if (flipped !== currentPlacement) {
      currentPlacement = flipped;
      coords = getPlacementCoords(triggerRect, contentRect, currentPlacement, offset);
      overflow = isOverflowing(coords, contentRect, boundary, padding);
    }
  }

  if (shift && (overflow.horizontal || overflow.vertical)) {
    coords = shiftPlacement(coords, contentRect, boundary, padding);
  }

  return {
    top: Math.round(coords.top),
    left: Math.round(coords.left),
    placement: currentPlacement,
    arrowPosition: coords.arrowPosition,
  };
}

import React from 'react';

export function usePosition(
  triggerRef: React.RefObject<HTMLElement>,
  contentRef: React.RefObject<HTMLElement>,
  options?: Partial<PositionOptions>
): PositionResult | null {
  const [position, setPosition] = React.useState<PositionResult | null>(null);

  React.useEffect(() => {
    if (!triggerRef.current || !contentRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current || !contentRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const contentRect = contentRef.current!.getBoundingClientRect();
      const result = calculatePosition({ ...options, triggerRect, contentRect });
      setPosition(result);
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, { capture: true, passive: true });

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [triggerRef, contentRef, options]);

  return position;
}