(function () {
    const MONTHS = [
        'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    const WEEKDAYS = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];

    const instances = new Map();
    let globalsBound = false;
    let overlayRoot = null;

    function ensureOverlayRoot() {
        if (overlayRoot && document.body.contains(overlayRoot)) return overlayRoot;
        overlayRoot = document.createElement('div');
        overlayRoot.className = 'cdp-overlay-root';
        document.body.appendChild(overlayRoot);
        return overlayRoot;
    }

    function parseIsoDate(iso) {
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return null;
        const [y, m, d] = String(iso).split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== (m - 1) || dt.getDate() !== d) return null;
        return dt;
    }

    function formatIsoDate(dt) {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatPtDateFromIso(iso) {
        const dt = parseIsoDate(iso);
        if (!dt) return '';
        const d = String(dt.getDate()).padStart(2, '0');
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const y = dt.getFullYear();
        return `${d}/${m}/${y}`;
    }

    function closeAll(except) {
        instances.forEach((inst) => {
            if (except && inst === except) return;
            inst.host.classList.remove('is-open');
            inst.panel.classList.remove('is-open', 'is-dropup');
            inst.trigger.setAttribute('aria-expanded', 'false');
        });
    }

    function positionPanel(inst) {
        if (!inst || !inst.host.classList.contains('is-open')) return;

        const triggerRect = inst.trigger.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const panelWidth = Math.min(320, Math.max(280, Math.round(triggerRect.width)));

        inst.panel.style.width = `${panelWidth}px`;

        const panelHeight = inst.panel.offsetHeight || 320;
        const margin = 8;
        let left = triggerRect.left;
        let top = triggerRect.bottom + 6;
        const openUp = top + panelHeight > (vh - margin) && (triggerRect.top - panelHeight - 6 >= margin);

        if (openUp) {
            top = triggerRect.top - panelHeight - 6;
            inst.panel.classList.add('is-dropup');
        } else {
            inst.panel.classList.remove('is-dropup');
        }

        if (left + panelWidth > (vw - margin)) {
            left = vw - panelWidth - margin;
        }
        if (left < margin) left = margin;

        inst.panel.style.left = `${Math.round(left)}px`;
        inst.panel.style.top = `${Math.round(Math.max(margin, top))}px`;
    }

    function positionOpenPanels() {
        instances.forEach((inst) => positionPanel(inst));
    }

    function syncViewFromValue(inst) {
        const selected = parseIsoDate(inst.input.value);
        const base = selected || new Date();
        inst.viewYear = base.getFullYear();
        inst.viewMonth = base.getMonth();
    }

    function updateTriggerText(inst) {
        const txt = formatPtDateFromIso(inst.input.value);
        const label = txt || inst.placeholder;
        inst.trigger.querySelector('.cdp-trigger-text').textContent = label;
        inst.trigger.classList.toggle('is-placeholder', !txt);
    }

    function setInputValue(inst, isoValue, fireEvents) {
        const old = inst.input.value || '';
        const next = isoValue || '';
        if (old === next && !fireEvents) return;

        inst.input.value = next;
        inst.lastValue = next;
        updateTriggerText(inst);
        renderCalendar(inst);

        if (fireEvents) {
            inst.input.dispatchEvent(new Event('input', { bubbles: true }));
            inst.input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function isToday(y, m, d) {
        const now = new Date();
        return (
            now.getFullYear() === y &&
            now.getMonth() === m &&
            now.getDate() === d
        );
    }

    function renderCalendar(inst) {
        const year = inst.viewYear;
        const month = inst.viewMonth;
        const label = `${MONTHS[month]} ${year}`;
        inst.monthLabel.textContent = label;

        const selectedIso = inst.input.value || '';

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const totalDays = lastDay.getDate();
        const offset = (firstDay.getDay() + 6) % 7; // segunda = 0

        let html = '';
        for (let i = 0; i < offset; i += 1) {
            html += '<span class="cdp-day-empty" aria-hidden="true"></span>';
        }

        for (let day = 1; day <= totalDays; day += 1) {
            const iso = formatIsoDate(new Date(year, month, day));
            const selectedClass = iso === selectedIso ? ' is-selected' : '';
            const todayClass = isToday(year, month, day) ? ' is-today' : '';
            html += `
                <button type="button" class="cdp-day${selectedClass}${todayClass}" data-cdp-day="${iso}">
                    ${day}
                </button>
            `;
        }

        inst.daysGrid.innerHTML = html;
    }

    function shiftMonth(inst, diff) {
        const next = new Date(inst.viewYear, inst.viewMonth + diff, 1);
        inst.viewYear = next.getFullYear();
        inst.viewMonth = next.getMonth();
        renderCalendar(inst);
    }

    function buildPicker(input) {
        const parent = input.parentElement;
        if (!parent) return;
        if (parent.closest('.cdp-host')) return;
        const canClear = !input.required;

        const host = document.createElement('div');
        host.className = 'cdp-host';
        parent.insertBefore(host, input);
        host.appendChild(input);

        input.type = 'hidden';
        input.classList.add('cdp-source');

        const placeholder = input.getAttribute('data-cdp-placeholder')
            || input.getAttribute('placeholder')
            || 'Selecionar data';

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'cdp-trigger is-placeholder';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = `
            <span class="cdp-trigger-text">${placeholder}</span>
            <i class="fas fa-calendar-alt" aria-hidden="true"></i>
        `;
        host.appendChild(trigger);

        const panel = document.createElement('div');
        panel.className = 'cdp-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'false');
        panel.setAttribute('data-cdp-panel', '1');
        panel.innerHTML = `
            <div class="cdp-header">
                <button type="button" class="cdp-nav-btn" data-cdp-act="prev" aria-label="Mes anterior">
                    <i class="fas fa-chevron-left"></i>
                </button>
                <span class="cdp-month-label">-</span>
                <button type="button" class="cdp-nav-btn" data-cdp-act="next" aria-label="Proximo mes">
                    <i class="fas fa-chevron-right"></i>
                </button>
            </div>
            <div class="cdp-weekdays">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div>
            <div class="cdp-days"></div>
            <div class="cdp-actions">
                <button type="button" class="cdp-action-btn" data-cdp-act="today">Hoje</button>
                <button type="button" class="cdp-action-btn ghost" data-cdp-act="clear"${canClear ? '' : ' disabled'}>Limpar</button>
            </div>
        `;
        ensureOverlayRoot().appendChild(panel);

        const inst = {
            input,
            host,
            trigger,
            panel,
            placeholder,
            monthLabel: panel.querySelector('.cdp-month-label'),
            daysGrid: panel.querySelector('.cdp-days'),
            viewYear: 0,
            viewMonth: 0,
            lastValue: input.value || ''
        };

        syncViewFromValue(inst);
        updateTriggerText(inst);
        renderCalendar(inst);

        trigger.addEventListener('click', (ev) => {
            ev.preventDefault();
            const opening = !host.classList.contains('is-open');
            closeAll(opening ? inst : null);
            host.classList.toggle('is-open', opening);
            panel.classList.toggle('is-open', opening);
            trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
            if (opening) {
                syncViewFromValue(inst);
                renderCalendar(inst);
                positionPanel(inst);
            }
        });

        panel.addEventListener('click', (ev) => {
            const actEl = ev.target.closest('[data-cdp-act]');
            if (actEl) {
                const act = actEl.getAttribute('data-cdp-act');
                if (act === 'prev') shiftMonth(inst, -1);
                if (act === 'next') shiftMonth(inst, 1);
                if (act === 'today') {
                    setInputValue(inst, formatIsoDate(new Date()), true);
                    closeAll();
                }
                if (act === 'clear') {
                    if (!canClear) return;
                    setInputValue(inst, '', true);
                    closeAll();
                }
                return;
            }

            const dayBtn = ev.target.closest('[data-cdp-day]');
            if (!dayBtn) return;
            const iso = dayBtn.getAttribute('data-cdp-day');
            if (!iso) return;
            setInputValue(inst, iso, true);
            closeAll();
        });

        if (input.id) {
            document.querySelectorAll(`label[for="${input.id}"]`).forEach((label) => {
                if (label.dataset.cdpBind === '1') return;
                label.dataset.cdpBind = '1';
                label.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    trigger.focus();
                    trigger.click();
                });
            });
        }

        instances.set(input, inst);
        input.dataset.cdpReady = '1';
    }

    function initCustomDatePickers(scope) {
        const root = scope || document;
        const dateInputs = root.querySelectorAll('input[type="date"]:not([data-cdp-ready])');
        dateInputs.forEach((input) => buildPicker(input));

        if (!globalsBound) {
            document.addEventListener('click', (ev) => {
                if (ev.target.closest('.cdp-host') || ev.target.closest('.cdp-panel')) return;
                closeAll();
            });

            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') closeAll();
            });

            window.addEventListener('resize', () => positionOpenPanels());
            window.addEventListener('scroll', () => positionOpenPanels(), true);

            globalsBound = true;
        }
    }

    window.initCustomDatePickers = initCustomDatePickers;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initCustomDatePickers(document));
    } else {
        initCustomDatePickers(document);
    }
})();
