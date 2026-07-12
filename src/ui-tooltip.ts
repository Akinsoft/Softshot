const ariaLabelAttribute = "aria-label";
const hiddenAttribute = "hidden";
const nativeTitleAttribute = "title";
const tooltipAboveClassName = "above";
const tooltipArrowXProperty = "--tooltip-arrow-x";
const tooltipBelowClassName = "below";
const tooltipClassName = "softshot-tooltip";
const tooltipOffsetPx = 10;
const tooltipSelector = "[data-tooltip]";
const tooltipViewportPaddingPx = 8;
const tooltipArrowInsetPx = 7;
const halfDivisor = 2;

type TooltipPlacement = typeof tooltipAboveClassName | typeof tooltipBelowClassName;

export class TooltipController {
  private readonly root: HTMLElement;
  private readonly tooltip = createTooltipElement();
  private activeTarget: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private hide(): void {
    this.activeTarget = null;
    this.tooltip.hidden = true;
  }

  private hideWhenRootLeaves({ relatedTarget }: FocusEvent | PointerEvent): void {
    if (relatedTarget instanceof Node && this.root.contains(relatedTarget)) {
      return;
    }

    this.hide();
  }

  private showForEvent(event: Event): void {
    const target = this.tooltipTargetFromEvent(event);
    if (!target) {
      this.hide();
      return;
    }

    if (target === this.activeTarget) {
      return;
    }

    this.show(target);
  }

  private show(target: HTMLElement): void {
    const text = target.dataset.tooltip;
    if (!text || isUnavailableTooltipTarget(target)) {
      this.hide();
      return;
    }

    this.activeTarget = target;
    this.tooltip.textContent = text;
    this.tooltip.hidden = false;
    this.tooltip.classList.remove(tooltipAboveClassName, tooltipBelowClassName);

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const targetCenterX = targetRect.left + targetRect.width / halfDivisor;
    const placement = tooltipPlacement(targetRect, tooltipRect);
    const tooltipTop = tooltipTopForPlacement(placement, targetRect, tooltipRect);
    const maximumLeft = window.innerWidth - tooltipRect.width - tooltipViewportPaddingPx;
    const tooltipLeft = clamp(
      targetCenterX - tooltipRect.width / halfDivisor,
      tooltipViewportPaddingPx,
      maximumLeft
    );
    const arrowX = clamp(targetCenterX - tooltipLeft, tooltipArrowInsetPx, tooltipRect.width - tooltipArrowInsetPx);

    this.tooltip.style.left = `${String(tooltipLeft)}px`;
    this.tooltip.style.top = `${String(tooltipTop)}px`;
    this.tooltip.style.setProperty(tooltipArrowXProperty, `${String(arrowX)}px`);
    this.tooltip.classList.add(placement);
  }

  private tooltipTargetFromEvent(event: Event): HTMLElement | null {
    if (!(event.target instanceof Element)) {
      return null;
    }

    const target = event.target.closest<HTMLElement>(tooltipSelector);
    if (!target || !this.root.contains(target)) {
      return null;
    }

    return target;
  }

  bind(): void {
    this.root.addEventListener("pointerover", (event): void => {
      this.showForEvent(event);
    });
    this.root.addEventListener("pointerout", (event): void => {
      this.hideWhenRootLeaves(event);
    });
    this.root.addEventListener("focusin", (event): void => {
      this.showForEvent(event);
    });
    this.root.addEventListener("focusout", (event): void => {
      this.hideWhenRootLeaves(event);
    });
    this.root.addEventListener("pointerdown", (): void => {
      this.hide();
    });
  }
}

export function setTooltipLabel(element: HTMLElement, label: string): void {
  element.dataset.tooltip = label;
  element.setAttribute(ariaLabelAttribute, label);
  element.removeAttribute(nativeTitleAttribute);
}

function clamp(value: number, minimum: number, maximum: number): number {
  const safeMaximum = Math.max(minimum, maximum);
  return Math.min(Math.max(value, minimum), safeMaximum);
}

function createTooltipElement(): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.className = tooltipClassName;
  tooltip.hidden = true;
  tooltip.setAttribute("role", "tooltip");
  document.body.append(tooltip);
  return tooltip;
}

function isUnavailableTooltipTarget(target: HTMLElement): boolean {
  return target.getAttribute(hiddenAttribute) !== null
    || target.ariaHidden === "true"
    || target.matches(":disabled");
}

function tooltipPlacement(targetRect: DOMRect, tooltipRect: DOMRect): TooltipPlacement {
  const minimumTopSpace = tooltipRect.height + tooltipOffsetPx + tooltipViewportPaddingPx;
  return targetRect.top >= minimumTopSpace ? tooltipAboveClassName : tooltipBelowClassName;
}

function tooltipTopForPlacement(placement: TooltipPlacement, targetRect: DOMRect, tooltipRect: DOMRect): number {
  if (placement === tooltipAboveClassName) {
    return targetRect.top - tooltipRect.height - tooltipOffsetPx;
  }

  return targetRect.bottom + tooltipOffsetPx;
}
