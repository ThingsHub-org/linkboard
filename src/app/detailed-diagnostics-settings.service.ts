import { Injectable, signal } from '@angular/core';

const storageKey = 'linkboard.detailedDiagnosticsEnabled';
const legacyStorageKey = 'linkboard.tuyaDetailedDiagnostics';
const persistenceErrorMessage = 'Impossibile salvare la preferenza della diagnostica dettagliata.';

@Injectable({ providedIn: 'root' })
export class DetailedDiagnosticsSettingsService {
  readonly enabled = signal(false);
  readonly persistenceError = signal<string | null>(null);

  constructor() {
    try {
      const savedValue = localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey);
      if (savedValue === 'true' || savedValue === 'false') this.enabled.set(savedValue === 'true');
    } catch {
      this.persistenceError.set(persistenceErrorMessage);
    }
  }

  setEnabled(enabled: boolean): boolean {
    try {
      localStorage.setItem(storageKey, String(enabled));
    } catch {
      this.persistenceError.set(persistenceErrorMessage);
      return false;
    }

    this.enabled.set(enabled);
    this.persistenceError.set(null);
    return true;
  }
}
