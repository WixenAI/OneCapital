import { useEffect, useMemo, useRef } from 'react';
import { createChart, CrosshairMode, LineSeries, TickMarkType } from 'lightweight-charts';

const IST_TIME_ZONE = 'Asia/Kolkata';

const IST_CROSSHAIR_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const IST_TIME_LABEL_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const IST_DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  day: '2-digit',
  month: 'short',
});

const IST_MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  month: 'short',
  year: '2-digit',
});

const IST_YEAR_LABEL_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
});

const toUnixSeconds = (value) => {
  if (value == null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.floor(Math.abs(value) > 1e12 ? value / 1000 : value);
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return null;

    if (/^-?\d+(\.\d+)?$/.test(normalized)) {
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) return null;
      return Math.floor(Math.abs(numeric) > 1e12 ? numeric / 1000 : numeric);
    }

    const timestampMs = new Date(normalized).getTime();
    if (!Number.isFinite(timestampMs)) return null;
    return Math.floor(timestampMs / 1000);
  }

  if (typeof value === 'object' && value !== null) {
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return Math.floor(Date.UTC(year, month - 1, day) / 1000);
    }
  }

  return null;
};

const normalizeLineData = (candles) => {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const byTime = new Map();

  candles.forEach((candle) => {
    const time = toUnixSeconds(candle?.[0]);
    const value = Number(candle?.[4]);
    if (time == null || !Number.isFinite(value)) return;
    byTime.set(time, value);
  });

  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
};

const TradingChart = ({ candles = [], timeframe = '1D', livePrice = null }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const lineSeriesRef = useRef(null);
  const priceLineRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const windowResizeHandlerRef = useRef(null);

  const lineData = useMemo(() => normalizeLineData(candles), [candles]);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const container = containerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth || 400,
      height: container.clientHeight || 320,
      autoSize: true,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#617589',
      },
      grid: {
        vertLines: { color: '#f0f2f4' },
        horzLines: { color: '#f0f2f4' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#95a6b5',
          width: 1,
          labelBackgroundColor: '#137fec',
        },
        horzLine: {
          color: '#95a6b5',
          width: 1,
          labelBackgroundColor: '#137fec',
        },
      },
      rightPriceScale: {
        borderColor: '#f0f2f4',
      },
      localization: {
        locale: 'en-IN',
        timeFormatter: (time) => {
          const seconds = toUnixSeconds(time);
          if (seconds == null) return '';
          return IST_CROSSHAIR_FORMATTER.format(new Date(seconds * 1000));
        },
      },
      timeScale: {
        borderColor: '#f0f2f4',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time, tickMarkType) => {
          const seconds = toUnixSeconds(time);
          if (seconds == null) return null;

          const date = new Date(seconds * 1000);
          if (tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds) {
            return IST_TIME_LABEL_FORMATTER.format(date);
          }
          if (tickMarkType === TickMarkType.DayOfMonth) {
            return IST_DAY_LABEL_FORMATTER.format(date);
          }
          if (tickMarkType === TickMarkType.Month) {
            return IST_MONTH_LABEL_FORMATTER.format(date);
          }
          if (tickMarkType === TickMarkType.Year) {
            return IST_YEAR_LABEL_FORMATTER.format(date);
          }
          return null;
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },
    });

    const lineSeries = chart.addSeries(LineSeries, {
      color: '#137fec',
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      lastValueVisible: true,
      priceLineVisible: true,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    lineSeriesRef.current = lineSeries;

    const resizeChart = () => {
      if (!containerRef.current || !chartRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (!width || !height) return;
      chartRef.current.applyOptions({ width, height });
    };

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserverRef.current = new ResizeObserver(resizeChart);
      resizeObserverRef.current.observe(container);
    } else {
      windowResizeHandlerRef.current = resizeChart;
      window.addEventListener('resize', windowResizeHandlerRef.current);
    }

    resizeChart();

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (windowResizeHandlerRef.current) {
        window.removeEventListener('resize', windowResizeHandlerRef.current);
        windowResizeHandlerRef.current = null;
      }
      if (lineSeriesRef.current && priceLineRef.current) {
        lineSeriesRef.current.removePriceLine(priceLineRef.current);
        priceLineRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      lineSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!lineSeriesRef.current) return;
    lineSeriesRef.current.setData(lineData);
    if (lineData.length > 1) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [lineData]);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.timeScale().applyOptions({
      timeVisible: timeframe === '1D',
      secondsVisible: false,
    });
  }, [timeframe]);

  useEffect(() => {
    const lineSeries = lineSeriesRef.current;
    if (!lineSeries) return;

    if (priceLineRef.current) {
      lineSeries.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }

    const price = Number(livePrice);
    if (!Number.isFinite(price) || lineData.length === 0) return;

    const lastTime = lineData[lineData.length - 1].time;
    lineSeries.update({ time: lastTime, value: price });
    priceLineRef.current = lineSeries.createPriceLine({
      price,
      color: '#137fec',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: 'LTP',
    });
  }, [lineData, livePrice]);

  return <div ref={containerRef} className="w-full h-full" />;
};

export default TradingChart;
