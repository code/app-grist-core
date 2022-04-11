// Provide a way to access grist for iframe, web worker (which runs the main safeBrowser script) and
// unsafeNode. WebView should work the same way as iframe, grist is exposed just the same way and
// necessary api is exposed using preload script. Here we bootstrap from channel capabilities to key
// parts of the grist API.

// For iframe (and webview):
// user will add '<script src="/grist-api.js"></script>' and get a window.grist

// For web worker:
// use will add `self.importScripts('/grist-api.js');`

// For node, user will do something like:
//   const {grist} = require('grist-api');
//   grist.registerFunction();
// In TypeScript:
//   import {grist} from 'grist-api';
//   grist.registerFunction();

// tslint:disable:no-console

import { ColumnsToMap, CustomSectionAPI, InteractionOptions, InteractionOptionsRequest,
         WidgetColumnMap } from './CustomSectionAPI';
import { GristAPI, GristDocAPI, GristView, RPC_GRISTAPI_INTERFACE } from './GristAPI';
import { RowRecord } from './GristData';
import { ImportSource, ImportSourceAPI, InternalImportSourceAPI } from './InternalImportSourceAPI';
import { decodeObject, mapValues } from './objtypes';
import { RenderOptions, RenderTarget } from './RenderOptions';
import { TableOperations } from './TableOperations';
import { TableOperationsImpl } from './TableOperationsImpl';
import { checkers } from './TypeCheckers';
import { WidgetAPI } from './WidgetAPI';

export * from './TypeCheckers';
export * from './FileParserAPI';
export * from './GristAPI';
export * from './GristTable';
export * from './ImportSourceAPI';
export * from './StorageAPI';
export * from './RenderOptions';
export * from './WidgetAPI';
export * from './CustomSectionAPI';

import {IRpcLogger, Rpc} from 'grain-rpc';

export const rpc: Rpc = new Rpc({logger: createRpcLogger()});

export const api = rpc.getStub<GristAPI>(RPC_GRISTAPI_INTERFACE, checkers.GristAPI);
export const coreDocApi = rpc.getStub<GristDocAPI>('GristDocAPI@grist', checkers.GristDocAPI);

/**
 * Interface for the records backing a custom widget.
 */
export const viewApi = rpc.getStub<GristView>('GristView', checkers.GristView);

/**
 * Interface for the state of a custom widget.
 */
export const widgetApi = rpc.getStub<WidgetAPI>('WidgetAPI', checkers.WidgetAPI);

/**
 * Interface for the mapping of a custom widget.
 */
export const sectionApi = rpc.getStub<CustomSectionAPI>('CustomSectionAPI', checkers.CustomSectionAPI);

/**
 * Shortcut for [[GristView.allowSelectBy]].
 */
export const allowSelectBy = viewApi.allowSelectBy;

/**
 * Shortcut for [[GristView.setSelectedRows]].
 */
export const setSelectedRows = viewApi.setSelectedRows;


/**
 * Fetches data backing the widget as for [[GristView.fetchSelectedTable]],
 * but decoding data by default, replacing e.g. ['D', timestamp] with
 * a moment date. Option `keepEncoded` skips the decoding step.
 */
export async function fetchSelectedTable(options: {keepEncoded?: boolean} = {}) {
  const table = await viewApi.fetchSelectedTable();
  return options.keepEncoded ? table :
    mapValues<any[], any[]>(table, (col) => col.map(decodeObject));
}

/**
 * Fetches current selected record as for [[GristView.fetchSelectedRecord]],
 * but decoding data by default, replacing e.g. ['D', timestamp] with
 * a moment date. Option `keepEncoded` skips the decoding step.
 */
export async function fetchSelectedRecord(rowId: number, options: {keepEncoded?: boolean} = {}) {
  const rec = await viewApi.fetchSelectedRecord(rowId);
  return options.keepEncoded ? rec :
    mapValues(rec, decodeObject);
}


/**
 * A collection of methods for fetching document data. The
 * fetchSelectedTable and fetchSelectedRecord methods are
 * overridden to decode data by default.
 */
export const docApi: GristDocAPI & GristView = {
  ...coreDocApi,
  ...viewApi,
  fetchSelectedTable,
  fetchSelectedRecord,
};

export const on = rpc.on.bind(rpc);

// Exposing widgetApi methods in a module scope.

/**
 * Shortcut for [[WidgetAPI.getOption]]
 */
export const getOption = widgetApi.getOption.bind(widgetApi);

/**
 * Shortcut for [[WidgetAPI.setOption]]
 */
export const setOption = widgetApi.setOption.bind(widgetApi);

/**
 * Shortcut for [[WidgetAPI.setOptions]]
 */
export const setOptions = widgetApi.setOptions.bind(widgetApi);

/**
 * Shortcut for [[WidgetAPI.getOptions]]
 */
export const getOptions = widgetApi.getOptions.bind(widgetApi);

/**
 * Shortcut for [[WidgetAPI.clearOptions]]
 */
export const clearOptions = widgetApi.clearOptions.bind(widgetApi);

/**
 * Get access to a table in the document. If no tableId specified, this
 * will use the current selected table (for custom widgets).
 * If a table does not exist, there will be no error until an operation
 * on the table is attempted.
 */
export function getTable(tableId?: string): TableOperations {
  return new TableOperationsImpl({
    async getTableId() {
      return tableId || await getSelectedTableId();
    },
    throwError(verb, text, status) {
      throw new Error(text);
    },
    applyUserActions(actions, opts) {
      return docApi.applyUserActions(actions, opts);
    },
  }, {});
}

/**
 * Get the current selected table (for custom widgets).
 */
export const selectedTable: TableOperations = getTable();

// Get the ID of the current selected table (for custom widgets).
// Will wait for the table ID to be set.
export async function getSelectedTableId(): Promise<string> {
  await _initialization;
  return _tableId!;
}

// Get the ID of the current selected table if set (for custom widgets).
// The ID may take some time to be set, or may never be set if the widget
// is not linked to anything.
export function getSelectedTableIdSync(): string|undefined {
  return _tableId;
}

// For custom widgets that support custom columns mappings store current configuration
// in a memory.

// Actual cached value. Undefined means that widget hasn't asked for configuration yet.
// Here we are storing serialized configuration instead of actual one, since widget can
// mutate returned value.
let _mappingsCache: WidgetColumnMap|null|undefined;
// Since widget needs to ask for mappings during onRecord and onRecords event, we will reuse
// current request if available;
let _activeRefreshReq: Promise<void>|null = null;
// Remember columns requested during ready call.
let _columnsToMap: ColumnsToMap|undefined;
let _tableId: string|undefined;
let _setInitialized: () => void;
const _initialization = new Promise<void>(resolve => _setInitialized = resolve);
let _readyCalled: boolean = false;

async function getMappingsIfChanged(data: any): Promise<WidgetColumnMap|null> {
  const uninitialized = _mappingsCache === undefined;
  if (data.mappingsChange || uninitialized) {
    // If no active request.
    if (!_activeRefreshReq) {
      // Request for new mappings.
      _activeRefreshReq = sectionApi
        .mappings()
        // Store it in global variable.
        .then(mappings => void (_mappingsCache = mappings))
        // Clear current request variable.
        .finally(() => _activeRefreshReq = null);
    }
    await _activeRefreshReq;
  }
  return _mappingsCache ? JSON.parse(JSON.stringify(_mappingsCache)) : null;
}

/**
 * Renames columns in the result using columns mapping configuration passed in ready method.
 * Returns null if not all required columns were mapped or not widget doesn't support
 * custom column mapping.
 */
export function mapColumnNames(data: any, options: {
  columns?: ColumnsToMap
  mappings?: WidgetColumnMap|null,
  reverse?: boolean,
}) {
  options = {columns: _columnsToMap, mappings: _mappingsCache, reverse: false, ...options};
  // If not column configuration was requested or
  // table has no rows, return original data.
  if (!options.columns) {
    return data;
  }
  // If we haven't received columns configuration return null.
  if (!options.mappings) {
    return null;
  }
  // If we are renaming names for whole table, but it is empty, don't do anything.
  if (Array.isArray(data) && data.length === 0) {
    return data;
  }

  // Prepare convert function - a function that will take record returned from Grist
  // and convert it to a new record with mapped field names;
  // Convert function will consists of several transformations:
  const transformations: ((from: any, to: any) => void)[] = [];
  // First transformation is for copying id field:
  transformations.push((from, to) => to.id = from.id);
  // Helper function to test if a column was configured as optional.
  function isOptional(col: string) {
    return Boolean(
      // Columns passed as strings are required.
      !options.columns?.includes(col)
      && options.columns?.find(c => typeof c === 'object' && c?.name === col && c.optional)
    );
  }
  // For each widget column in mapping.
  // Keys are ordered for determinism in case of conflicts.
  for(const widgetCol of Object.keys(options.mappings).sort()) {
    // Get column from Grist.
    const gristCol = options.mappings[widgetCol];
    // Copy column as series (multiple values)
    if (Array.isArray(gristCol) && gristCol.length) {
      if (!options.reverse) {
        transformations.push((from, to) => {
          to[widgetCol] = gristCol.map(col => from[col]);
        });
      } else {
        transformations.push((from, to) => {
          for (const [idx, col] of gristCol.entries()) {
            to[col] = from[widgetCol]?.[idx];
          }
        });
      }
      // Copy column directly under widget column name.
    } else if (!Array.isArray(gristCol) && gristCol) {
      if (!options.reverse) {
        transformations.push((from, to) => to[widgetCol] = from[gristCol]);
      } else {
        transformations.push((from, to) => to[gristCol] = from[widgetCol]);
      }
    } else if (!isOptional(widgetCol)) {
      // Column was not configured but was required.
      return null;
    }
  }
  // Finally assemble function to convert a single record.
  const convert = (rec: any) => transformations.reduce((obj, tran) => { tran(rec, obj); return obj; }, {} as any);
  // Transform all records (or a single one depending on the arguments).
  return Array.isArray(data) ? data.map(convert) : convert(data);
}

/**
 * Offer a convenient way to map data with renamed columns back into the
 * form used in the original table. This is useful for making edits to the
 * original table in a widget with column mappings. As for mapColumnNames(),
 * we don't attempt to do these transformations automatically.
 */
export function mapColumnNamesBack(data: any, options: {
  columns?: ColumnsToMap
  mappings?: WidgetColumnMap|null,
}) {
  return mapColumnNames(data, {...options, reverse: true});
}

/**
 * For custom widgets, add a handler that will be called whenever the
 * row with the cursor changes - either by switching to a different row, or
 * by some value within the row potentially changing.  Handler may
 * in the future be called with null if the cursor moves away from
 * any row.
 * TODO: currently this will be called even if the content of a different row
 * changes.
 */
export function onRecord(callback: (data: RowRecord | null, mappings: WidgetColumnMap | null) => unknown) {
  on('message', async function(msg) {
    if (!msg.tableId || !msg.rowId || msg.rowId === 'new') { return; }
    const rec = await docApi.fetchSelectedRecord(msg.rowId);
    callback(rec, await getMappingsIfChanged(msg));
  });
}

/**
 * For custom widgets, add a handler that will be called whenever the
 * new (blank) row is selected.
 */
export function onNewRecord(callback: () => unknown) {
  on('message', async function(msg) {
    if (msg.tableId && msg.rowId === 'new') {
      callback();
    }
  });
}

/**
 * For custom widgets, add a handler that will be called whenever the
 * selected records change.  Handler will be called with a list of records.
 */
export function onRecords(callback: (data: RowRecord[], mappings: WidgetColumnMap | null) => unknown) {
  on('message', async function(msg) {
    if (!msg.tableId || !msg.dataChange) { return; }
    const data = await docApi.fetchSelectedTable();
    if (!data.id) { return; }
    const rows: RowRecord[] = [];
    for (let i = 0; i < data.id.length; i++) {
      const row: RowRecord = {id: data.id[i]};
      for (const key of Object.keys(data)) {
        row[key] = data[key][i];
      }
      rows.push(row);
    }
    callback(rows, await getMappingsIfChanged(msg));
  });
}


/**
 * For custom widgets, add a handler that will be called whenever the
 * widget options change (and on initial ready message). Handler will be
 * called with an object containing saved json options, or null if no options were saved.
 * The second parameter has information about the widgets relationship with
 * the document that contains it.
 */
export function onOptions(callback: (options: any, settings: InteractionOptions) => unknown) {
  on('message', async function(msg) {
    if (msg.settings) {
      callback(msg.options || null, msg.settings);
    }
  });
}

/**
 * Calling `addImporter(...)` adds a safeBrowser importer. It is a short-hand for forwarding calls
 * to an `ImportSourceAPI` implementation registered in the file at `path`. It takes care of
 * creating the stub, registering an implementation that renders the file, forward the call and
 * dispose the view properly. If `mode` is `'inline'` embeds the view in the import modal, otherwise
 * renders fullscreen.
 *
 * Notes: it assumes that file at `path` registers an `ImportSourceAPI` implementation under
 * `name`. Calling `addImporter(...)` from another component than a `safeBrowser` component is not
 * currently supported.
 *
 * @internal
 */
export async function addImporter(name: string, path: string, mode: 'fullscreen' | 'inline', options?: RenderOptions) {
  // checker is omitted for implementation because call was already checked by grist.
  rpc.registerImpl<InternalImportSourceAPI>(name, {
    async getImportSource(target: RenderTarget): Promise<ImportSource|undefined> {
      const procId = await api.render(path, mode === 'inline' ? target : 'fullscreen', options);
      try {
        // stubName for the interface `name` at forward destination `path`
        const stubName = `${name}@${path}`;
        // checker is omitted in stub because call will be checked just after in grist.
        return await rpc.getStub<ImportSourceAPI>(stubName).getImportSource();
      } finally {
        await api.dispose(procId);
      }
    }
  });
}

/**
 * Options when initializing connection to Grist.
 */
export interface ReadyPayload extends Omit<InteractionOptionsRequest, "hasCustomOptions"> {
  /**
   * Handler that will be called by Grist to open additional configuration panel inside the Custom Widget.
   */
  onEditOptions: () => unknown;
}
/**
 * Declare that a component is prepared to receive messages from the outside world.
 * Grist will not attempt to communicate with it until this method is called.
 */
export function ready(settings?: ReadyPayload): void {
  // Make it safe for this method to be called multiple times.
  if (_readyCalled) { return; }
  _readyCalled = true;

  if (settings && settings.onEditOptions) {
    rpc.registerFunc('editOptions', settings.onEditOptions);
  }
  on('message', async function(msg) {
    if (msg.tableId && msg.tableId !== _tableId) {
      if (!_tableId) { _setInitialized(); }
      _tableId = msg.tableId;
    }
  });
  rpc.processIncoming();
  void (async function() {
    await rpc.sendReadyMessage();
    if (settings) {
      const options = {
        ...(settings),
        hasCustomOptions: Boolean(settings.onEditOptions),
      };
      delete options.onEditOptions;
      _columnsToMap = options.columns;
      await sectionApi.configure(options).catch((err: unknown) => console.error(err));
    }
  })();
}

/** @internal */
function getPluginPath(location: Location) {
  return location.pathname.replace(/^\/plugins\//, '');
}

if (typeof window !== 'undefined') {
  // Window or iframe.
  const preloadWindow: any = window;
  if (preloadWindow.isRunningUnderElectron) {
    rpc.setSendMessage(msg => preloadWindow.sendToHost(msg));
    preloadWindow.onGristMessage((data: any) => rpc.receiveMessage(data));
  } else {
    rpc.setSendMessage(msg => window.parent.postMessage(msg, "*"));
    window.onmessage = (e: MessageEvent) => rpc.receiveMessage(e.data);
  }

  // Allow outer Grist application to trigger printing. This is similar to using
  // iframe.contentWindow.print(), but that call does not work cross-domain.
  rpc.registerFunc("print", () => window.print());

} else if (typeof process === 'undefined') {
  // Web worker. We can't really bring in the types for WebWorker (available with --lib flag)
  // without conflicting with a regular window, so use just use `self as any` here.
  self.onmessage = (e: MessageEvent) => rpc.receiveMessage(e.data);
  rpc.setSendMessage((mssg: any) => (self as any).postMessage(mssg));
} else if (typeof process.send !== 'undefined') {
  // Forked ChildProcess of node or electron.
  // sendMessage callback returns void 0 because rpc process.send returns a boolean and rpc
  // expecting void|Promise interprets truthy values as Promise which cause failure.
  rpc.setSendMessage((data) => { process.send!(data); });
  process.on('message', (data: any) => rpc.receiveMessage(data));
  process.on('disconnect', () => { process.exit(0); });
} else {
  // Not a recognized environment, perhaps plain nodejs run independently of Grist, or tests
  // running under mocha. For now, we only provide a dysfunctional implementation. It allows
  // plugins to call methods like registerFunction() without failing, so that plugin code may be
  // imported, but the methods don't do anything useful.
  rpc.setSendMessage((data) => { return; });
}

/** @internal */
function createRpcLogger(): IRpcLogger {
  let prefix: string;
  if (typeof window !== 'undefined') {
    prefix = `PLUGIN VIEW ${getPluginPath(window.location)}:`;
  } else if (typeof process === 'undefined') {
    prefix = `PLUGIN VIEW ${getPluginPath(self.location)}:`;
  } else if (typeof process.send !== 'undefined') {
    prefix = `PLUGIN NODE ${process.env.GRIST_PLUGIN_PATH || "<unset-plugin-id>"}:`;
  } else {
    return {};
  }
  return {
    info(msg: string) { console.log("%s %s", prefix, msg); },
    warn(msg: string) { console.warn("%s %s", prefix, msg); },
  };
}
