import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
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
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';

import { LinkNfcService } from '../link-nfc.service';
import type { SavedLink } from '../link.repository';
import { LinkStore } from '../link.store';

interface CallState {
  status: 'loading' | 'success' | 'unverified' | 'error';
  message: string;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [FormsModule, IonContent, IonIcon, RouterLink],
})
export class HomePage {
  private readonly http = inject(HttpClient);
  private readonly linkStore = inject(LinkStore);
  private readonly nfc = inject(LinkNfcService);
  readonly links = this.linkStore.links;
  readonly persistenceError = this.linkStore.persistenceError;
  readonly isLoadingLinks = this.linkStore.isLoading;
  readonly nfcSupported = this.nfc.isSupported;
  readonly isScanningNfc = signal(false);
  readonly nfcMessage = signal('');
  searchTerm = '';
  private readonly callStates = signal<Record<string, CallState>>({});
  private stopNfcScan: (() => void) | null = null;

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
    inject(DestroyRef).onDestroy(() => this.stopNfcScanner());
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
    this.setCallState(link.id, { status: 'loading', message: 'Invio richiesta GET...' });
    if (this.isPrivateHttpUrl(link.url)) {
      await this.callPrivateHttpLink(link, timeoutMs);
      return;
    }

    try {
      const response = await firstValueFrom(
        this.http.get(link.url, { observe: 'response', responseType: 'text' }).pipe(timeout({ first: timeoutMs })),
      );
      const succeeded = response.status >= 200 && response.status < 300;
      this.setCallState(link.id, {
        status: succeeded ? 'success' : 'error',
        message: succeeded
          ? `Risposta HTTP ${response.status}: chiamata riuscita.`
          : `Risposta HTTP ${response.status}.`,
      });
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      const message = status
        ? `Chiamata non riuscita: HTTP ${status}.`
        : error instanceof TimeoutError
          ? `Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta.`
          : 'Richiesta bloccata o non raggiungibile: verifica rete e CORS.';
      this.setCallState(link.id, { status: 'error', message });
    }
  }

  private async callPrivateHttpLink(link: SavedLink, timeoutMs: number): Promise<void> {
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
        this.setCallState(link.id, {
          status: 'unverified',
          message: 'Risposta ricevuta, ma il codice HTTP non è leggibile per CORS.',
        });
        return;
      }

      const succeeded = response.status >= 200 && response.status < 300;
      this.setCallState(link.id, {
        status: succeeded ? 'success' : 'error',
        message: succeeded
          ? `Risposta HTTP ${response.status}: chiamata riuscita.`
          : `Risposta HTTP ${response.status}.`,
      });
    } catch {
      this.setCallState(link.id, {
        status: 'error',
        message: timedOut
          ? `Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta.`
          : 'Richiesta non riuscita: verifica rete e dispositivo.',
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
      this.nfcMessage.set('Scansione NFC interrotta.');
      return;
    }

    this.nfcMessage.set('');
    try {
      this.stopNfcScan = await this.nfc.startScanning(
        (linkId) => {
          const link = this.links().find((item) => item.id === linkId);
          if (!link) {
            this.nfcMessage.set('Il link associato al tag non è più configurato.');
            return;
          }

          this.nfcMessage.set(`Tag letto: avvio la chiamata per ${link.name}.`);
          void this.callLink(link).then(() => {
            const result = this.requestState(link.id);
            if (result) this.nfcMessage.set(`Tag letto: ${result.message}`);
          });
        },
        () => this.nfcMessage.set('Tag NFC non associato a un link di Linkboard.'),
        (error) => {
          this.stopNfcScanner();
          this.nfcMessage.set(this.nfc.errorMessage(error));
        },
      );
      this.isScanningNfc.set(true);
      this.nfcMessage.set('Scansione attiva. Avvicina un tag associato.');
    } catch (error) {
      this.stopNfcScanner();
      this.nfcMessage.set(this.nfc.errorMessage(error));
    }
  }

  private setCallState(id: string, state: CallState): void {
    this.callStates.update((current) => ({ ...current, [id]: state }));
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
