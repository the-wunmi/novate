// The picture of what clearing does: everything members owed flows into the house, and only the
// payments that were really needed flow out. What netted out fades away and never moves.
import { useLayoutEffect, useRef, useState } from 'react';
import type { CycleView } from './types.ts';
import { formatMajor, Kpi, Money, sumBig, toMajor } from './ui.tsx';

const BAR = 8;
const GAP = 22;
const MIN_BAND = 3;
const TOP = 30;
const LABEL_GAP = 10;
/** Roughly how wide a label is at 13px, so the picture leaves room for its words. */
const textWidth = (text: string) => text.length * 8.4 + 12;

const ribbon = (x1: number, a1: number, b1: number, x2: number, a2: number, b2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1},${a1} C${mid},${a1} ${mid},${a2} ${x2},${a2} L${x2},${b2} C${mid},${b2} ${mid},${b1} ${x1},${b1} Z`;
};

export function nettingTotals(cycle: CycleView) {
  const currency = cycle.owed[0]?.currency ?? cycle.paid[0]?.currency ?? 'EUR';
  const owed = sumBig(cycle.owed.filter((o) => o.currency === currency));
  const paid = sumBig(cycle.paid.filter((p) => p.currency === currency && p.status !== 'reversed'));
  const netted = owed > paid ? owed - paid : 0n;
  const share = owed > 0n ? Number((netted * 1000n) / owed) / 10 : 0;
  return { currency, owed, paid, netted, share };
}

/** The width the picture really has, so its type stays at reading size whatever the panel. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry?.contentRect.width ?? 0)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function NettingRibbon({
  cycle,
  name,
  animate,
  compact = false,
}: {
  cycle: CycleView;
  name: (id: string) => string;
  animate: boolean;
  compact?: boolean;
}) {
  const [ref, width] = useWidth();
  const { currency, owed, paid, netted } = nettingTotals(cycle);
  const owedRows = cycle.owed.filter((o) => o.currency === currency);
  const payouts = cycle.paid.filter((p) => p.currency === currency && p.status !== 'reversed');
  const amount = (minor: string | bigint) => `${formatMajor(minor, currency)} ${currency}`;

  const leftLabel = Math.max(
    120,
    ...owedRows.map((o) => textWidth(`${name(o.payer)} owes ${name(o.payee)}`)),
  );
  const rightLabel = Math.max(
    120,
    ...payouts.map((p) => textWidth(`Paid ${name(p.memberId)}`)),
    textWidth(amount(netted)),
  );
  const W = Math.max(width, leftLabel + rightLabel + 240);
  const LEFT_X = leftLabel + LABEL_GAP;
  const RIGHT_X = W - rightLabel - LABEL_GAP - BAR;
  const CENTER_X = (LEFT_X + BAR + RIGHT_X) / 2 - BAR / 2;

  const maxHeight = compact ? 140 : 210;
  const total = Math.max(toMajor(owed, currency), toMajor(paid, currency)) || 1;
  const k = maxHeight / total;
  const size = (minor: string | bigint) => Math.max(MIN_BAND, toMajor(minor, currency) * k);

  // Left: one band per obligation, spaced apart. Center: the same bands, packed together.
  let y = TOP;
  const left = owedRows.map((o) => {
    const hgt = size(o.amount);
    const band = { o, top: y, hgt };
    y += hgt + GAP;
    return band;
  });
  const leftBottom = y - GAP;
  const centerHeight = left.reduce((t, b) => t + b.hgt, 0);
  const centerTop = TOP + Math.max(0, (leftBottom - TOP - centerHeight) / 2);
  let cy = centerTop;
  const inbound = left.map((b) => {
    const at = cy;
    cy += b.hgt;
    return { ...b, centerTop: at };
  });

  // Right: what moved leaves the top of the center; what netted out leaves the bottom and fades.
  let ry = TOP;
  let fromCenter = centerTop;
  const outbound = payouts.map((p) => {
    const hgt = size(p.amount);
    const centerHgt = toMajor(p.amount, currency) * k;
    const band = { p, top: ry, hgt, centerTop: fromCenter, centerHgt };
    ry += hgt + GAP;
    fromCenter += centerHgt;
    return band;
  });
  const ghostHeight = netted > 0n ? Math.max(MIN_BAND, centerTop + centerHeight - fromCenter) : 0;
  const ghostTop = Math.max(ry, fromCenter);
  const height = Math.max(leftBottom, ghostTop + ghostHeight, centerTop + centerHeight) + 12;
  const mid = (top: number, hgt: number) => top + hgt / 2;
  const rightText = RIGHT_X + BAR + LABEL_GAP;

  return (
    <div ref={ref} className="ribbon-frame">
      {width > 0 && (
        <svg
          className={`ribbon${animate ? ' animate' : ''}`}
          // When the labels need more room than the panel has, the picture scales down to fit.
          width={Math.min(W, width)}
          height={(height * Math.min(W, width)) / W}
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label={`${amount(owed)} gross obligations, ${amount(paid)} paid out, ${amount(netted)} offset by netting`}
        >
          <text x={LEFT_X + BAR} y={14} textAnchor="end" className="lbl-head">
            Gross obligations
          </text>
          <text x={CENTER_X + BAR / 2} y={14} textAnchor="middle" className="lbl-head">
            Netting
          </text>
          <text x={RIGHT_X} y={14} className="lbl-head">
            Paid out
          </text>

          {inbound.map((b) => (
            <g key={`in-${b.o.dealId}-${b.o.payer}`}>
              <path
                className="band-owed"
                d={ribbon(
                  LEFT_X + BAR,
                  b.top,
                  b.top + b.hgt,
                  CENTER_X,
                  b.centerTop,
                  b.centerTop + b.hgt,
                )}
              />
              <rect className="bar-owed" x={LEFT_X} y={b.top} width={BAR} height={b.hgt} rx={1.5} />
              <text x={leftLabel} y={mid(b.top, b.hgt) - 3} textAnchor="end" className="lbl-strong">
                {name(b.o.payer)} owes {name(b.o.payee)}
              </text>
              <text x={leftLabel} y={mid(b.top, b.hgt) + 13} textAnchor="end" className="lbl-muted">
                {amount(b.o.amount)}
              </text>
            </g>
          ))}

          <rect
            className="node"
            x={CENTER_X}
            y={centerTop}
            width={BAR}
            height={centerHeight}
            rx={2}
          />

          {outbound.map((b) => (
            <g key={`out-${b.p.memberId}-${b.p.externalRef ?? b.top}`}>
              <path
                className="band-moved"
                d={ribbon(
                  CENTER_X + BAR,
                  b.centerTop,
                  b.centerTop + b.centerHgt,
                  RIGHT_X,
                  b.top,
                  b.top + b.hgt,
                )}
              />
              <rect
                className="bar-moved"
                x={RIGHT_X}
                y={b.top}
                width={BAR}
                height={b.hgt}
                rx={1.5}
              />
              <text x={rightText} y={mid(b.top, b.hgt) - 3} className="lbl-moved">
                Paid {name(b.p.memberId)}
              </text>
              <text x={rightText} y={mid(b.top, b.hgt) + 13} className="lbl-muted">
                {amount(b.p.amount)}
              </text>
            </g>
          ))}

          {ghostHeight > 0 && (
            <g>
              <path
                className="band-gone"
                d={ribbon(
                  CENTER_X + BAR,
                  fromCenter,
                  fromCenter + ghostHeight,
                  RIGHT_X,
                  ghostTop,
                  ghostTop + ghostHeight,
                )}
              />
              <rect
                className="bar-gone"
                x={RIGHT_X}
                y={ghostTop}
                width={BAR}
                height={ghostHeight}
                rx={1.5}
              />
              <text x={rightText} y={mid(ghostTop, ghostHeight) - 3} className="lbl-strong">
                Offset by netting
              </text>
              <text x={rightText} y={mid(ghostTop, ghostHeight) + 13} className="lbl-muted">
                {amount(netted)}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

export function NettingSummary({ cycle }: { cycle: CycleView }) {
  const { currency, owed, paid, netted, share } = nettingTotals(cycle);
  return (
    <div className="kpis">
      <Kpi label="Gross obligations" figure={<Money value={owed} currency={currency} />} />
      <Kpi label="Paid out" figure={<Money value={paid} currency={currency} />} />
      <Kpi label="Offset by netting" figure={<Money value={netted} currency={currency} />} />
      <Kpi label="Netting efficiency" figure={`${share.toFixed(0)}%`} />
    </div>
  );
}
