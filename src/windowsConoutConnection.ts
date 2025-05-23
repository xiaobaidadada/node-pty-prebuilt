/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */

import { Worker } from 'worker_threads';
import { Socket } from 'net';
import { IDisposable } from './types';
import { IWorkerData, ConoutWorkerMessage, getWorkerPipeName } from './shared/conout';
import { join } from 'path';
import { IEvent, EventEmitter2 } from './eventEmitter2';

/**
 * The amount of time to wait for additional data after the conpty shell process has exited before
 * shutting down the worker and sockets. The timer will be reset if a new data event comes in after
 * the timer has started.
 */
const FLUSH_DATA_INTERVAL = 1000;

const worker = `
"use strict";
/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */
Object.defineProperty(exports, "__esModule", { value: true });
var worker_threads_1 = require("worker_threads");
var net_1 = require("net");
var conoutPipeName = worker_threads_1.workerData.conoutPipeName;
var conoutSocket = new net_1.Socket();
conoutSocket.setEncoding('utf8');
conoutSocket.connect(conoutPipeName, function () {
    var server = net_1.createServer(function (workerSocket) {
        conoutSocket.pipe(workerSocket);
    });
    server.listen(conoutPipeName + "-worker");
    if (!worker_threads_1.parentPort) {
        throw new Error('worker_threads parentPort is null');
    }
    worker_threads_1.parentPort.postMessage(1);
});
//# sourceMappingURL=conoutSocketWorker.js.map
`;

/**
 * Connects to and manages the lifecycle of the conout socket. This socket must be drained on
 * another thread in order to avoid deadlocks where Conpty waits for the out socket to drain
 * when `ClosePseudoConsole` is called. This happens when data is being written to the terminal when
 * the pty is closed.
 *
 * See also:
 * - https://github.com/microsoft/node-pty/issues/375
 * - https://github.com/microsoft/vscode/issues/76548
 * - https://github.com/microsoft/terminal/issues/1810
 * - https://docs.microsoft.com/en-us/windows/console/closepseudoconsole
 */
export class ConoutConnection implements IDisposable {
  private _worker: Worker;
  private _drainTimeout: NodeJS.Timeout | undefined;
  private _isDisposed: boolean = false;

  private _onReady = new EventEmitter2<void>();
  public get onReady(): IEvent<void> { return this._onReady.event; }

  constructor(
    private _conoutPipeName: string,
    private _useConptyDll: boolean
  ) {
    const workerData: IWorkerData = { conoutPipeName: _conoutPipeName };
    const scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');
    this._worker = new Worker(join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData });
    this._worker.on('message', (message: ConoutWorkerMessage) => {
      switch (message) {
        case ConoutWorkerMessage.READY:
          this._onReady.fire();
          return;
        default:
          console.warn('Unexpected ConoutWorkerMessage', message);
      }
    });
  }

  dispose(): void {
    if (!this._useConptyDll && this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    // Drain all data from the socket before closing
    this._drainDataAndClose();
  }

  connectSocket(socket: Socket): void {
    socket.connect(getWorkerPipeName(this._conoutPipeName));
  }

  private _drainDataAndClose(): void {
    if (this._drainTimeout) {
      clearTimeout(this._drainTimeout);
    }
    this._drainTimeout = setTimeout(() => this._destroySocket(), FLUSH_DATA_INTERVAL);
  }

  private async _destroySocket(): Promise<void> {
    await this._worker.terminate();
  }
}
