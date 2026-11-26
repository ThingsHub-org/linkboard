import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import type { HttpHeaders } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import type { OnInit } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowDownOutline,
  arrowUpOutline,
  checkmarkOutline,
  closeOutline,
  globeOutline,
  linkOutline,
  searchOutline,
  settingsOutline,
} from 'ionicons/icons';
import { filter, firstValueFrom, take, TimeoutError, timeout } from 'rxjs';

import packageJson from '../../../package.json';
import { DetailedDiagnosticsSettingsService } from '../detailed-diagnostics-settings.service';
import { LinkNfcService } from '../link-nfc.service';
import type { SavedLink } from '../link.repository';
import { LinkStore } from '../link.store';
import { NativePlatformService } from '../native-platform.service';
import type { NativeHttpResponse } from '../native-platform.service';
import type { RequestDiagnosticExchange } from '../request-diagnostics.types';
import { TuyaRequestError, TuyaService } from '../tuya.service';

interface CallState {
  status: 'loading' | 'success' | 'unverified' | 'error';
  message: string;
  diagnostics?: string;
  copyMessage?: string;
}

const callResultDisplayDurationMs = 5000;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [FormsModule, IonContent, IonIcon, RouterLink],
})
export class HomePage implements OnInit {
  readonly appVersion = packageJson.version;
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly linkStore = inject(LinkStore);
  private readonly nfc = inject(LinkNfcService);
  private readonly nativeNfc = inject(NativePlatformService);
  private readonly tuya = inject(TuyaService);
  private readonly diagnosticsSettings = inject(DetailedDiagnosticsSettingsService);
  readonly detailedDiagnosticsEnabled = this.diagnosticsSettings.enabled;
  private readonly linksLoaded = firstValueFrom(
    toObservable(this.linkStore.isLoading).pipe(
      filter((isLoading) => !isLoading),
      take(1),
    ),
  );
  readonly links = this.linkStore.links;
  readonly persistenceError = this.linkStore.persistenceError;
  readonly isLoadingLinks = this.linkStore.isLoading;
  readonly nfcSupported = this.nfc.isSupported;
  readonly isNativeNfcApp = this.nativeNfc.isAndroidApp;
  readonly isScanningNfc = signal(false);
  readonly nfcMessage = signal('');
  searchTerm = '';
  private readonly callStates = signal<Record<string, CallState>>({});
  private readonly callResultTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private nfcMessageTimeout: ReturnType<typeof setTimeout> | null = null;
  private nfcRequestSequence = 0;
  private stopNfcScan: (() => void) | null = null;
  private stopNativeNfc: (() => void) | null = null;

  constructor() {
    addIcons({
      arrowDownOutline,
      arrowUpOutline,
      checkmarkOutline,
      closeOutline,
      globeOutline,
      linkOutline,
      searchOutline,
      settingsOutline,
    });
    inject(DestroyRef).onDestroy(() => {
      this.stopNfcScanner();
      this.stopNativeNfc?.();
      this.clearCallResultTimeouts();
      this.clearNfcMessageTimeout();
    });
  }

  ngOnInit(): void {
    if (this.nativeNfc.isAndroidApp) {
      void this.startNativeNfcListener();
      return;
    }
    if (this.nfcSupported) void this.toggleNfcScan();
  }

  get filteredLinks(): SavedLink[] {
    const query = this.searchTerm.trim().toLocaleLowerCase();
    const links = this.links();
    if (!query) return links;

    return links.filter((link) => `${link.name} ${this.hostname(link.url)}`.toLocaleLowerCase().includes(query));
  }

  requestState(id: string): CallState | undefined {
    return this.callStates()[id];
  }

  moveLink(id: string, direction: -1 | 1): void {
    const visibleLinks = this.filteredLinks;
    const index = visibleLinks.findIndex((link) => link.id === id);
    const target = visibleLinks[index + direction];
    if (index < 0 || !target) return;

    this.linkStore.swap(id, target.id);
  }

  blurNavigationFocus(event: Event): void {
    (event.currentTarget as HTMLElement).blur();
  }

  async callLink(link: SavedLink, timeoutMs = 15000): Promise<void> {
    if (this.callStates()[link.id]?.status === 'loading') return;
    const isTuyaLink = link.type === 'tuya';
    const diagnosticsEnabled = this.diagnosticsSettings.enabled();
    this.setCallState(link.id, {
      status: 'loading',
      message: isTuyaLink ? 'Autenticazione e invio comando Tuya...' : 'Invio richiesta GET...',
    });
    if (isTuyaLink) {
      await this.callTuyaLink(link, timeoutMs);
      return;
    }
    if (this.isNativeAndroidApp) {
      await this.callNativeHttpLink(link, timeoutMs, diagnosticsEnabled);
      return;
    }
    if (this.isPrivateHttpUrl(link.url)) {
      await this.callPrivateHttpLink(link, timeoutMs, diagnosticsEnabled);
      return;
    }

    const exchange = diagnosticsEnabled ? createGetDiagnostic(link.url) : undefined;
    try {
      const response = await firstValueFrom(
        this.http.get(link.url, { observe: 'response', responseType: 'text' }).pipe(timeout({ first: timeoutMs })),
      );
      const succeeded = response.status >= 200 && response.status < 300;
      if (exchange) {
        exchange.response = {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: httpHeadersToRecord(response.headers),
          body: response.body,
        };
      }
      const message = succeeded
        ? `Risposta HTTP ${response.status}: chiamata riuscita.`
        : `Risposta HTTP ${response.status}.`;
      this.setCallState(link.id, {
        status: succeeded ? 'success' : 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      if (exchange) {
        exchange.failure = error instanceof Error ? error.message : String(error);
        if (error instanceof HttpErrorResponse) {
          exchange.response = {
            status: error.status,
            statusText: error.statusText,
            url: error.url,
            headers: httpHeadersToRecord(error.headers),
            body: error.error,
          };
        }
      }
      const message = status
        ? `Chiamata non riuscita: HTTP ${status}.`
        : error instanceof TimeoutError
          ? `Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta.`
          : 'Richiesta bloccata o non raggiungibile: verifica rete e CORS.';
      this.setCallState(link.id, {
        status: 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    }
  }

  private async callTuyaLink(link: Extract<SavedLink, { type: 'tuya' }>, timeoutMs: number): Promise<void> {
    try {
      const exchanges = await this.tuya.execute(link, timeoutMs);
      const message = 'Comando Tuya ricevuto; lo stato fisico del dispositivo non è verificato.';
      this.setCallState(link.id, {
        status: 'success',
        message,
        ...(exchanges?.length ? { diagnostics: this.formatDiagnostics(message, exchanges) } : {}),
      });
    } catch (error) {
      this.setCallState(link.id, {
        status: 'error',
        message: error instanceof Error ? error.message : 'Chiamata Tuya non riuscita.',
        ...(error instanceof TuyaRequestError && error.diagnostics?.length
          ? { diagnostics: this.formatDiagnostics(error.message, error.diagnostics) }
          : {}),
      });
    }
  }

  async copyDiagnostics(id: string, diagnostics: string): Promise<void> {
    let copied = await this.copyDiagnosticsToClipboard(diagnostics);
    if (!copied) copied = this.copyDiagnosticsFallback(diagnostics);

    this.callStates.update((current) => {
      const state = current[id];
      return state
        ? {
            ...current,
            [id]: {
              ...state,
              copyMessage: copied
                ? 'Diagnostica copiata.'
                : 'Copia automatica non riuscita: seleziona il testo e copialo.',
            },
          }
        : current;
    });
  }

  closeDiagnostics(id: string): void {
    const state = this.callStates()[id];
    if (!state?.diagnostics) return;

    this.setCallState(id, { ...state, diagnostics: undefined, copyMessage: undefined });
  }

  private async copyDiagnosticsToClipboard(diagnostics: string): Promise<boolean> {
    try {
      const clipboard = this.document.defaultView?.navigator.clipboard;
      if (!clipboard?.writeText) return false;
      await clipboard.writeText(diagnostics);
      return true;
    } catch {
      return false;
    }
  }

  private copyDiagnosticsFallback(diagnostics: string): boolean {
    const textarea = this.document.createElement('textarea');
    textarea.value = diagnostics;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    try {
      this.document.body.append(textarea);
      textarea.select();
      return this.document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }

  private diagnosticsState(message: string, exchange: RequestDiagnosticExchange | undefined): { diagnostics?: string } {
    return exchange ? { diagnostics: this.formatDiagnostics(message, [exchange]) } : {};
  }

  private formatDiagnostics(message: string, exchanges: RequestDiagnosticExchange[]): string {
    return JSON.stringify({ message, exchanges }, null, 2);
  }

  private async callNativeHttpLink(link: SavedLink, timeoutMs: number, diagnosticsEnabled: boolean): Promise<void> {
    const exchange = diagnosticsEnabled ? createGetDiagnostic(link.url) : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    });

    try {
      const response = await Promise.race([this.nativeNfc.httpGet(link.url, timeoutMs), timeoutPromise]);
      const succeeded = response.status >= 200 && response.status < 300;
      if (exchange) exchange.response = nativeDiagnosticResponse(response);
      const message = succeeded
        ? `Risposta HTTP ${response.status}: chiamata riuscita.`
        : `Risposta HTTP ${response.status}.`;
      this.setCallState(link.id, {
        status: succeeded ? 'success' : 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : 0;
      if (exchange) {
        exchange.failure = error instanceof Error ? error.message : String(error);
        const response = nativeErrorDiagnosticResponse(error);
        if (response) exchange.response = response;
      }
      const message = status
        ? `Chiamata non riuscita: HTTP ${status}.`
        : error instanceof TimeoutError
          ? `Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta.`
          : 'Richiesta bloccata o non raggiungibile: verifica rete e configurazione Android.';
      this.setCallState(link.id, {
        status: 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private get isNativeAndroidApp(): boolean {
    return this.nativeNfc.isAndroidApp;
  }

  private async callPrivateHttpLink(link: SavedLink, timeoutMs: number, diagnosticsEnabled: boolean): Promise<void> {
    const exchange = diagnosticsEnabled
      ? createGetDiagnostic(link.url, 'Richiesta inviata in modalità no-cors.')
      : undefined;
    if (exchange) exchange.request.mode = 'no-cors';
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(link.url, {
        method: 'GET',
        mode: 'no-cors',
        signal: controller.signal,
      });
      if (response.type === 'opaque') {
        const message = 'Risposta ricevuta, ma il codice HTTP non è leggibile per CORS.';
        if (exchange) {
          exchange.failure = 'Il browser non espone status, header o body per una risposta opaque no-cors.';
          exchange.response = {
            status: 0,
            statusText: 'Opaque response',
            url: response.url || link.url,
            headers: {},
            body: null,
            type: response.type,
          };
        }
        this.setCallState(link.id, {
          status: 'unverified',
          message,
          ...this.diagnosticsState(message, exchange),
        });
        return;
      }

      const succeeded = response.status >= 200 && response.status < 300;
      const body = await response.text();
      if (exchange) {
        exchange.response = {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: responseHeadersToRecord(response.headers),
          body,
          type: response.type,
        };
      }
      const message = succeeded
        ? `Risposta HTTP ${response.status}: chiamata riuscita.`
        : `Risposta HTTP ${response.status}.`;
      this.setCallState(link.id, {
        status: succeeded ? 'success' : 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    } catch (error) {
      if (exchange) exchange.failure = error instanceof Error ? error.message : String(error);
      const message = timedOut
        ? `Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta.`
        : 'Richiesta non riuscita: verifica rete e dispositivo.';
      this.setCallState(link.id, {
        status: 'error',
        message,
        ...this.diagnosticsState(message, exchange),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private isPrivateHttpUrl(url: string): boolean {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:') return false;

    const octets = parsedUrl.hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return false;
    }

    const [first, second] = octets;
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }

  async toggleNfcScan(): Promise<void> {
    if (this.stopNfcScan) {
      this.stopNfcScanner();
      this.setNfcMessage('Scansione NFC interrotta.');
      return;
    }
    if (this.isScanningNfc()) return;

    this.setNfcMessage('');
    this.isScanningNfc.set(true);
    try {
      this.stopNfcScan = await this.nfc.startScanning(
        (linkId) => void this.handleNfcLinkId(linkId),
        () => this.setNfcMessage('Tag NFC non associato a un link di Linkboard.'),
        (error) => {
          this.stopNfcScanner();
          this.setNfcMessage(this.nfc.errorMessage(error));
        },
      );
      this.setNfcMessage('Scansione attiva. Avvicina un tag associato.');
    } catch (error) {
      this.stopNfcScanner();
      this.setNfcMessage(this.nfc.errorMessage(error));
    }
  }

  private async startNativeNfcListener(): Promise<void> {
    const waitingMessage = 'In attesa di tag NFC...';
    this.setNfcMessage(waitingMessage);
    try {
      this.stopNativeNfc = await this.nativeNfc.listenForTags((linkId) => void this.handleNfcLinkId(linkId));
      const available = await this.nativeNfc.isAvailable();
      if (this.nfcMessage() === waitingMessage) {
        this.setNfcMessage(
          available ? 'Avvicina un tag NFC associato per avviare la chiamata.' : 'NFC non disponibile o disattivato.',
        );
      }
    } catch (error) {
      this.setNfcMessage(error instanceof Error ? error.message : 'Impossibile inizializzare la scansione NFC.');
    }
  }

  private async handleNfcLinkId(linkId: string): Promise<void> {
    if (this.isLoadingLinks()) await this.linksLoaded;
    const requestSequence = ++this.nfcRequestSequence;
    const link = this.links().find((item) => item.id === linkId);
    if (!link) {
      this.setNfcMessage('Il link associato al tag non è più configurato.');
      return;
    }

    this.setNfcMessage(`Tag letto: avvio la chiamata per ${link.name}.`);
    await this.callLink(link);
    if (requestSequence !== this.nfcRequestSequence) return;
    const result = this.requestState(link.id);
    if (result) this.setNfcMessage(`Tag letto: ${result.message}`, result.status !== 'loading');
  }

  private setNfcMessage(message: string, promptForNextScan = false): void {
    this.clearNfcMessageTimeout();
    this.nfcMessage.set(message);
    if (!promptForNextScan) return;

    this.nfcMessageTimeout = setTimeout(() => {
      this.nfcMessageTimeout = null;
      this.nfcMessage.set('Avvicina un altro tag NFC associato per una nuova scansione.');
    }, callResultDisplayDurationMs);
  }

  private clearNfcMessageTimeout(): void {
    if (this.nfcMessageTimeout) clearTimeout(this.nfcMessageTimeout);
    this.nfcMessageTimeout = null;
  }

  private setCallState(id: string, state: CallState): void {
    const previousTimeout = this.callResultTimeouts.get(id);
    if (previousTimeout) clearTimeout(previousTimeout);
    this.callResultTimeouts.delete(id);
    this.callStates.update((current) => ({ ...current, [id]: state }));

    if (state.status === 'loading') this.scrollCallResultIntoView(id);
    if (state.diagnostics) {
      this.scrollCallResultIntoView(id);
      return;
    }
    if (state.status !== 'success' && state.status !== 'error' && !state.diagnostics) return;

    this.scrollCallResultIntoView(id);
    const timeoutId = setTimeout(() => {
      if (this.callResultTimeouts.get(id) !== timeoutId) return;
      this.callResultTimeouts.delete(id);
      this.callStates.update((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, callResultDisplayDurationMs);
    this.callResultTimeouts.set(id, timeoutId);
  }

  private clearCallResultTimeouts(): void {
    for (const timeoutId of this.callResultTimeouts.values()) clearTimeout(timeoutId);
    this.callResultTimeouts.clear();
  }

  private scrollCallResultIntoView(id: string): void {
    const view = this.document.defaultView;
    if (!view) return;

    view.requestAnimationFrame(() => {
      const card = Array.from(this.document.querySelectorAll<HTMLElement>('.launcher-card[data-link-id]')).find(
        (element) => element.dataset['linkId'] === id,
      );
      if (!card) return;

      const bounds = card.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > view.innerHeight) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  private stopNfcScanner(): void {
    this.stopNfcScan?.();
    this.stopNfcScan = null;
    this.isScanningNfc.set(false);
  }

  hostname(url: string): string {
    return new URL(url).hostname.replace(/^www\./, '');
  }
}

function createGetDiagnostic(url: string, note?: string): RequestDiagnosticExchange {
  return {
    request: {
      method: 'GET',
      url,
      headers: {},
      note: [
        note,
        'Nessun header personalizzato impostato da Linkboard; gli header aggiunti automaticamente dal trasporto potrebbero non essere accessibili.',
      ]
        .filter(Boolean)
        .join(' '),
    },
  };
}

function httpHeadersToRecord(headers: HttpHeaders): Record<string, string> {
  return Object.fromEntries(
    headers.keys().map((key): [string, string] => [key, headers.getAll(key)?.join(', ') ?? '']),
  );
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function nativeDiagnosticResponse(response: NativeHttpResponse): NonNullable<RequestDiagnosticExchange['response']> {
  return {
    status: response.status,
    url: response.url,
    headers: response.headers,
    body: response.data,
  };
}

function nativeErrorDiagnosticResponse(value: unknown): RequestDiagnosticExchange['response'] | undefined {
  if (!isRecord(value) || typeof value['status'] !== 'number') return undefined;

  const headers = isRecord(value['headers'])
    ? Object.fromEntries(
        Object.entries(value['headers']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};

  return {
    status: value['status'],
    ...(typeof value['statusText'] === 'string' ? { statusText: value['statusText'] } : {}),
    ...(typeof value['url'] === 'string' ? { url: value['url'] } : {}),
    headers,
    body: value['data'] ?? value['error'] ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
