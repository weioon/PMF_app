import { Injectable } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, interval } from 'rxjs';

/**
 * Automatic PWA Version Update Service (`@angular/pwa` + `SwUpdate`).
 * Checks for newly deployed versions (e.g. from Vercel / Firebase after `git push`),
 * downloads the new bundle in the background, and activates it WITHOUT clearing
 * the user's local IndexedDB / localStorage financial database.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  constructor(private readonly swUpdate: SwUpdate) {
    this.initAutoUpdateWatcher();
  }

  private initAutoUpdateWatcher(): void {
    if (!this.swUpdate.isEnabled) return;

    // Poll every 15 minutes when app is open
    interval(15 * 60 * 1000).subscribe(() => {
      this.swUpdate.checkForUpdate().catch(() => {});
    });

    // Listen for newly downloaded version and activate
    this.swUpdate.versionUpdates
      .pipe(filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'))
      .subscribe(() => {
        this.activateLatestVersion();
      });
  }

  async checkForUpdatesNow(): Promise<boolean> {
    if (!this.swUpdate.isEnabled) return false;
    return this.swUpdate.checkForUpdate();
  }

  async activateLatestVersion(): Promise<void> {
    if (this.swUpdate.isEnabled) {
      await this.swUpdate.activateUpdate();
    }
    document.location.reload();
  }
}

