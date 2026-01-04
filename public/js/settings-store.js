/**
 * Settings Store
 */
document.addEventListener('alpine:init', () => {
    Alpine.store('settings', {
        refreshInterval: 60,
        logLimit: 2000,
        showExhausted: true,
        showHiddenModels: false, // New field
        compact: false,
        port: 8080, // Display only

        init() {
            this.loadSettings();

            // Auto-save specific settings immediately when changed
            this.$watch('showHiddenModels', () => this.saveSettings(true));
            this.$watch('showExhausted', () => this.saveSettings(true));
            this.$watch('compact', () => this.saveSettings(true));
        },

        loadSettings() {
            const saved = localStorage.getItem('antigravity_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.keys(parsed).forEach(k => {
                    // Only load keys that exist in our default state (safety)
                    if (this.hasOwnProperty(k)) this[k] = parsed[k];
                });
            }
        },

        saveSettings(silent = false) {
            const toSave = {
                refreshInterval: this.refreshInterval,
                logLimit: this.logLimit,
                showExhausted: this.showExhausted,
                showHiddenModels: this.showHiddenModels,
                compact: this.compact
            };
            localStorage.setItem('antigravity_settings', JSON.stringify(toSave));

            if (!silent) {
                Alpine.store('global').showToast('Configuration Saved', 'success');
            }

            // Trigger updates
            document.dispatchEvent(new CustomEvent('refresh-interval-changed'));
            if (Alpine.store('data')) {
                Alpine.store('data').computeQuotaRows();
            }
        }
    });
});
