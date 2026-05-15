export const APP_TIME_ZONE = 'Europe/Istanbul';
export const APP_TIME_ZONE_OFFSET = '+03:00';

type DateInput = Date | string | number;

const toValidDate = (value: DateInput): Date | null => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getIstanbulParts = (value: DateInput = new Date()) => {
  const date = toValidDate(value) || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date);

  const getPart = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '00';

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second'),
  };
};

export const getIstanbulDateKey = (value: DateInput = new Date()): string => {
  const parts = getIstanbulParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const getIstanbulTimestamp = (value: DateInput = new Date()): string => {
  const parts = getIstanbulParts(value);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${APP_TIME_ZONE_OFFSET}`;
};

export const getIstanbulDayStart = (dateKey: string): Date => new Date(`${dateKey}T00:00:00.000${APP_TIME_ZONE_OFFSET}`);

export const getIstanbulDayEnd = (dateKey: string): Date => new Date(`${dateKey}T23:59:59.999${APP_TIME_ZONE_OFFSET}`);

export const formatIstanbulDate = (
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): string => {
  const date = toValidDate(value);
  if (!date) return '';

  return new Intl.DateTimeFormat(locale, {
    timeZone: APP_TIME_ZONE,
    ...options,
    hourCycle: 'h23',
    hour12: false,
  }).format(date);
};

export const formatIstanbulDateTime = (
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): string => {
  const date = toValidDate(value);
  if (!date) return '';
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };

  return new Intl.DateTimeFormat(locale, {
    timeZone: APP_TIME_ZONE,
    ...(Object.keys(options).length ? options : defaultOptions),
    hourCycle: 'h23',
    hour12: false,
  }).format(date);
};
