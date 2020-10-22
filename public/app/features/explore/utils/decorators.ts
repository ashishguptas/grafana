import {
  AbsoluteTimeRange,
  DataFrame,
  FieldType,
  getDisplayProcessor,
  PanelData,
  sortLogsResult,
  standardTransformers,
  TIME_SERIES_VALUE_FIELD_NAME,
} from '@grafana/data';
import { config } from '@grafana/runtime';
import { AxisSide } from '@grafana/ui';
import { groupBy } from 'lodash';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { dataFrameToLogsModel } from '../../../core/logs_model';
import { refreshIntervalToSortOrder } from '../../../core/utils/explore';
import { ExplorePanelData } from '../../../types';

/**
 * When processing response first we try to determine what kind of dataframes we got as one query can return multiple
 * dataFrames with different type of data. This is later used for type specific processing. As we use this in
 * Observable pipeline, it decorates the existing panelData to pass the results to later processing stages.
 */
export const decorateWithGraphLogsTraceAndTable = (data: PanelData): ExplorePanelData => {
  if (data.error) {
    return {
      ...data,
      graphFrames: [],
      tableFrames: [],
      logsFrames: [],
      traceFrames: [],
      graphResult: null,
      tableResult: null,
      logsResult: null,
    };
  }

  const graphFrames: DataFrame[] = [];
  const tableFrames: DataFrame[] = [];
  const logsFrames: DataFrame[] = [];
  const traceFrames: DataFrame[] = [];

  for (const frame of data.series) {
    switch (frame.meta?.preferredVisualisationType) {
      case 'logs':
        logsFrames.push(frame);
        break;
      case 'graph':
        graphFrames.push(frame);
        break;
      case 'trace':
        traceFrames.push(frame);
        break;
      case 'table':
        tableFrames.push(frame);
        break;
      default:
        if (isTimeSeries(frame)) {
          graphFrames.push(frame);
          tableFrames.push(frame);
        } else {
          // We fallback to table if we do not have any better meta info about the dataframe.
          tableFrames.push(frame);
        }
    }
  }

  return {
    ...data,
    graphFrames,
    tableFrames,
    logsFrames,
    traceFrames,
    graphResult: null,
    tableResult: null,
    logsResult: null,
  };
};

export const decorateWithGraphResult = (data: ExplorePanelData): ExplorePanelData => {
  if (data.error || !data.graphFrames.length) {
    return { ...data, graphResult: null };
  }

  // Set the field config of the value field to show graph lines
  const graphResult = [...data.graphFrames];
  for (const graph of graphResult) {
    const valueField = graph.fields.find(f => f.name === TIME_SERIES_VALUE_FIELD_NAME);
    if (valueField) {
      valueField.config = {
        custom: {
          axis: { label: '', side: AxisSide.Left, width: 60, grid: true },
          bars: { show: false },
          fill: { alpha: 0.1 },
          line: { show: true, width: 1 },
          nullValues: 'null',
          points: { show: false, radius: 4 },
        },
        ...valueField.config,
      };
    }
  }

  return { ...data, graphResult };
};

/**
 * This processing returns Observable because it uses Transformer internally which result type is also Observable.
 * In this case the transformer should return single result but it is possible that in the future it could return
 * multiple results and so this should be used with mergeMap or similar to unbox the internal observable.
 */
export const decorateWithTableResult = (data: ExplorePanelData): Observable<ExplorePanelData> => {
  if (data.error) {
    return of({ ...data, tableResult: null });
  }

  if (data.tableFrames.length === 0) {
    return of({ ...data, tableResult: null });
  }

  data.tableFrames.sort((frameA: DataFrame, frameB: DataFrame) => {
    const frameARefId = frameA.refId!;
    const frameBRefId = frameB.refId!;

    if (frameARefId > frameBRefId) {
      return 1;
    }
    if (frameARefId < frameBRefId) {
      return -1;
    }
    return 0;
  });

  const hasOnlyTimeseries = data.tableFrames.every(df => isTimeSeries(df));

  // If we have only timeseries we do join on default time column which makes more sense. If we are showing
  // non timeseries or some mix of data we are not trying to join on anything and just try to merge them in
  // single table, which may not make sense in most cases, but it's up to the user to query something sensible.
  const transformer = hasOnlyTimeseries
    ? of(data.tableFrames).pipe(standardTransformers.seriesToColumnsTransformer.operator({}))
    : of(data.tableFrames).pipe(standardTransformers.mergeTransformer.operator({}));

  return transformer.pipe(
    map(frames => {
      const frame = frames[0];

      // set display processor
      for (const field of frame.fields) {
        field.display =
          field.display ??
          getDisplayProcessor({
            field,
            theme: config.theme,
            timeZone: data.request?.timezone ?? 'browser',
          });
      }

      return { ...data, tableResult: frame };
    })
  );
};

export const decorateWithLogsResult = (
  options: { absoluteRange?: AbsoluteTimeRange; refreshInterval?: string } = {}
) => (data: ExplorePanelData): ExplorePanelData => {
  if (data.error) {
    return { ...data, logsResult: null };
  }

  if (data.logsFrames.length === 0) {
    return { ...data, logsResult: null };
  }

  const timeZone = data.request?.timezone ?? 'browser';
  const intervalMs = data.request?.intervalMs;
  const newResults = dataFrameToLogsModel(data.logsFrames, intervalMs, timeZone, options.absoluteRange);
  const sortOrder = refreshIntervalToSortOrder(options.refreshInterval);
  const sortedNewResults = sortLogsResult(newResults, sortOrder);
  const rows = sortedNewResults.rows;
  const series = sortedNewResults.series;
  const logsResult = { ...sortedNewResults, rows, series };

  return { ...data, logsResult };
};

/**
 * Check if frame contains time series, which for our purpose means 1 time column and 1 or more numeric columns.
 */
function isTimeSeries(frame: DataFrame): boolean {
  const grouped = groupBy(frame.fields, field => field.type);
  return Boolean(
    Object.keys(grouped).length === 2 && grouped[FieldType.time]?.length === 1 && grouped[FieldType.number]
  );
}