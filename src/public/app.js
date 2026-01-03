/**
 * Dashboard Client Logic
 */

// Format time duration
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(' ');
}

// Format date relative
function timeAgo(timestamp) {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " mins ago";
    return Math.floor(seconds) + " seconds ago";
}

// Format rate limits display
function formatLimits(limits) {
    if (!limits || Object.keys(limits).length === 0) return 'None';

    const active = Object.entries(limits)
        .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now())
        .map(([model, limit]) => {
            const timeLeft = Math.ceil((limit.resetTime - Date.now()) / 1000);
            return `<span class="limit-tag">${model} (${timeLeft}s)</span>`;
        });

    return active.length > 0 ? active.join(' ') : 'None';
}

function updateDashboard() {
    fetch('/api/dashboard/status')
        .then(response => response.json())
        .then(data => {
            // Update connection status
            const statusBadge = document.getElementById('connection-status');
            statusBadge.textContent = 'Connected';
            statusBadge.className = 'status-badge connected';

            // Update stats
            document.getElementById('uptime').textContent = formatUptime(data.uptime);
            document.getElementById('version').textContent = `v${data.version}`;
            document.getElementById('total-accounts').textContent = data.accounts.total;
            document.getElementById('active-accounts').textContent = data.accounts.available;

            // Update table
            const tbody = document.getElementById('accounts-table-body');
            tbody.innerHTML = '';

            data.accounts.list.forEach(account => {
                const tr = document.createElement('tr');

                // Determine status
                let statusClass = 'active';
                let statusText = 'Active';

                if (account.isInvalid) {
                    statusClass = 'invalid';
                    statusText = 'Invalid';
                } else if (account.hasActiveLimits) {
                    statusClass = 'limited';
                    statusText = 'Rate Limited';
                }

                tr.innerHTML = `
                    <td>
                        <div style="font-weight: 500">${account.email}</div>
                        <div style="font-size: 0.8em; color: var(--text-secondary)">${account.source || 'File'}</div>
                    </td>
                    <td>
                        <div class="status ${statusClass}">
                            <span class="status-dot"></span>${statusText}
                        </div>
                        ${account.invalidReason ? `<div style="font-size: 0.8em; color: var(--error)">${account.invalidReason}</div>` : ''}
                    </td>
                    <td>${timeAgo(account.lastUsed)}</td>
                    <td>${formatLimits(account.modelRateLimits)}</td>
                `;
                tbody.appendChild(tr);
            });
        })
        .catch(err => {
            console.error('Fetch error:', err);
            const statusBadge = document.getElementById('connection-status');
            statusBadge.textContent = 'Disconnected';
            statusBadge.className = 'status-badge disconnected';
        });
}

// Initial update
updateDashboard();

// Poll every 5 seconds
setInterval(updateDashboard, 5000);
