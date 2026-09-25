(() => {
        'use strict';

        const TIME_ZONE = 'Asia/Tokyo';
        const REFRESH_INTERVAL_MS = 60 * 1000;
        const HOVER_DELAY_MS = 250;
        const CALENDAR_STORAGE_KEY = 'danpro-employee-calendar:v1';
        const CALENDAR_STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
        const ERROR_CODES = Object.freeze({
          accessDenied: 'ACCESS_DENIED',
          unauthenticated: 'UNAUTHENTICATED',
          dataFetchFailed: 'DATA_FETCH_FAILED',
        });
        const FALLBACK_LEVELS = [
          { level: 0, symbol: '◎', label: '余裕あり' },
          { level: 1, symbol: '○', label: '対応可能' },
          { level: 2, symbol: '△', label: 'やや混雑' },
          { level: 3, symbol: '×', label: '混雑' },
        ];
        const LEVEL_COLORS = ['#f2f7f3', '#d9eddc', '#a9d5ad', '#287444'];
        const LEVEL_SYMBOLS = ['◎', '○', '△', '×'];
        const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
        const hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)');
        const startupTimingOrigin = window.performance && typeof window.performance.now === 'function'
          ? window.performance.now()
          : 0;
        const startupTiming = {
          htmlDisplayStartedMs: 0,
          cachedCalendarRenderedMs: null,
          getCalendarDataStartedMs: null,
          getCalendarDataCompletedMs: null,
          latestCalendarRenderedMs: null,
          serverTiming: null,
        };
        window.__danproCalendarTiming = startupTiming;

        const elements = {
          loginPanel: document.getElementById('login-panel'),
          loginError: document.getElementById('login-error'),
          calendarPanel: document.getElementById('calendar-panel'),
          logout: document.getElementById('logout'),
          calendarWrap: document.getElementById('calendar-wrap'),
          grid: document.getElementById('calendar-grid'),
          monthTitle: document.getElementById('month-title'),
          statusText: document.getElementById('status-text'),
          spinner: document.getElementById('spinner'),
          error: document.getElementById('error'),
          legend: document.getElementById('legend'),
          previousMonth: document.getElementById('previous-month'),
          nextMonth: document.getElementById('next-month'),
          today: document.getElementById('today'),
          sourceLink: document.getElementById('source-link'),
          hoverPreview: document.getElementById('hover-preview'),
          detailBackdrop: document.getElementById('detail-backdrop'),
          detailModal: document.getElementById('detail-modal'),
          detailTitle: document.getElementById('detail-title'),
          detailBody: document.getElementById('detail-body'),
          detailClose: document.getElementById('detail-close'),
        };

        let tokyoToday = getDatePartsInTimeZone(new Date(), TIME_ZONE);
        let viewYear = tokyoToday.year;
        let viewMonth = tokyoToday.month;
        let calendarData = new Map();
        let hasLoadedSuccessfully = false;
        let isLoading = false;
        let showingCachedCalendar = false;
        let detailRevision = null;
        let detailGeneration = 0;
        let modalRequestToken = 0;
        let hoverRequestToken = 0;
        let hoverTimer = 0;
        let lastFocusedElement = null;
        let activeModalDate = null;
        let sessionConfirmed = false;
        let refreshTimer = 0;
        const detailCache = new Map();
        const detailPending = new Map();

        async function fetchJson(url, options = {}) {
          const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            ...options,
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const code = response.status === 401
              ? ERROR_CODES.unauthenticated
              : response.status === 403
                ? ERROR_CODES.accessDenied
                : ERROR_CODES.dataFetchFailed;
            throw { code, status: response.status };
          }
          return payload;
        }

        function clearEmployeeState() {
          clearCachedCalendar();
          invalidateDetailCache();
          calendarData = new Map();
          hasLoadedSuccessfully = false;
          showingCachedCalendar = false;
          detailRevision = null;
          cancelHover();
          closeDetails();
          hideSourceLink();
          renderCalendar();
        }

        function showLogin(message = '') {
          sessionConfirmed = false;
          window.clearInterval(refreshTimer);
          refreshTimer = 0;
          clearEmployeeState();
          elements.calendarPanel.hidden = true;
          elements.loginPanel.hidden = false;
          elements.loginError.textContent = message;
          elements.loginError.hidden = !message;
        }

        function showCalendar() {
          sessionConfirmed = true;
          elements.loginPanel.hidden = true;
          elements.calendarPanel.hidden = false;
          elements.loginError.hidden = true;
        }

        function pad2(value) {
          return String(value).padStart(2, '0');
        }

        function toDateKey(year, month, day) {
          return `${year}-${pad2(month)}-${pad2(day)}`;
        }

        function markStartupTiming(name) {
          if (startupTiming[name] !== null) return;
          const current = window.performance && typeof window.performance.now === 'function'
            ? window.performance.now()
            : startupTimingOrigin;
          startupTiming[name] = Math.max(0, Math.round((current - startupTimingOrigin) * 10) / 10);
        }

        function isValidDateKey(value) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
          const [year, month, day] = value.split('-').map(Number);
          const date = new Date(year, month - 1, day);
          return date.getFullYear() === year
            && date.getMonth() === month - 1
            && date.getDate() === day;
        }

        function parseCachedCalendar(value) {
          try {
            const cached = JSON.parse(value);
            const now = Date.now();
            if (
              !cached
              || cached.version !== 1
              || !Number.isFinite(cached.savedAt)
              || cached.savedAt > now + 5 * 60 * 1000
              || now - cached.savedAt > CALENDAR_STORAGE_TTL_MS
              || !Array.isArray(cached.days)
              || cached.days.length === 0
              || cached.days.length > 800
              || !Array.isArray(cached.levels)
              || cached.levels.length !== 4
              || typeof cached.updatedAt !== 'string'
              || Number.isNaN(Date.parse(cached.updatedAt))
            ) return null;

            const daysAreSafe = cached.days.every((day) => (
              day
              && Object.keys(day).sort().join(',') === 'count,date,level,symbol'
              && typeof day.date === 'string'
              && isValidDateKey(day.date)
              && Number.isInteger(day.count)
              && day.count >= 0
              && Number.isInteger(day.level)
              && day.level >= 0
              && day.level < LEVEL_SYMBOLS.length
              && day.symbol === LEVEL_SYMBOLS[day.level]
            ));
            const levelsAreSafe = cached.levels.every((level, index) => (
              level
              && Object.keys(level).sort().join(',') === 'label,level,symbol'
              && level.level === index
              && level.symbol === LEVEL_SYMBOLS[index]
              && typeof level.label === 'string'
              && level.label.length <= 30
            ));
            if (!daysAreSafe || !levelsAreSafe) return null;
            return {
              days: cached.days,
              levels: cached.levels,
              updatedAt: cached.updatedAt,
            };
          } catch (error) {
            return null;
          }
        }

        function restoreCachedCalendar() {
          if (!sessionConfirmed) return false;
          let cached = null;
          try {
            cached = parseCachedCalendar(window.localStorage.getItem(CALENDAR_STORAGE_KEY));
            if (!cached) window.localStorage.removeItem(CALENDAR_STORAGE_KEY);
          } catch (error) {
            return false;
          }
          if (!cached) return false;

          chooseInitialMonth(cached.days);
          calendarData = new Map(cached.days.map((day) => [day.date, day]));
          hasLoadedSuccessfully = true;
          showingCachedCalendar = true;
          renderLegend(cached.levels);
          renderCalendar();
          elements.statusText.textContent = `前回データを表示中 · ${formatUpdatedAt(cached.updatedAt)}`;
          markStartupTiming('cachedCalendarRenderedMs');
          return true;
        }

        function clearCachedCalendar() {
          try {
            window.localStorage.removeItem(CALENDAR_STORAGE_KEY);
          } catch (error) {
            // Storage無効でも画面上の権限制御は継続します。
          }
        }

        function saveCachedCalendar(data) {
          try {
            const days = data.days.map((day) => ({
              date: day.date,
              count: day.count,
              level: day.level,
              symbol: day.symbol,
            }));
            const levels = data.levels.map((level) => ({
              level: level.level,
              symbol: level.symbol,
              label: level.label,
            }));
            window.localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify({
              version: 1,
              savedAt: Date.now(),
              days,
              levels,
              updatedAt: data.updatedAt,
            }));
          } catch (error) {
            // Storage無効・容量超過でも通常取得は継続します。
          }
        }

        function getDatePartsInTimeZone(date, timeZone) {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
          }).formatToParts(date);
          const values = {};
          parts.forEach((part) => {
            if (part.type !== 'literal') values[part.type] = Number(part.value);
          });
          return { year: values.year, month: values.month, day: values.day };
        }

        function formatDateHeading(dateKey) {
          const [year, month, day] = dateKey.split('-').map(Number);
          const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
          return `${month}月${day}日（${weekday}）`;
        }

        function renderCalendar() {
          tokyoToday = getDatePartsInTimeZone(new Date(), TIME_ZONE);
          elements.monthTitle.textContent = `${viewYear}年 ${viewMonth}月`;
          elements.grid.replaceChildren();

          const firstDay = new Date(viewYear, viewMonth - 1, 1);
          const firstDayOffset = firstDay.getDay();
          const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
          const cellCount = Math.ceil((firstDayOffset + daysInMonth) / 7) * 7;

          for (let index = 0; index < cellCount; index += 1) {
            const day = index - firstDayOffset + 1;
            if (day < 1 || day > daysInMonth) {
              const emptyCell = document.createElement('div');
              emptyCell.className = 'day outside';
              emptyCell.setAttribute('aria-hidden', 'true');
              elements.grid.appendChild(emptyCell);
              continue;
            }

            const date = new Date(viewYear, viewMonth - 1, day);
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const key = toDateKey(year, month, day);
            const item = calendarData.get(key);
            const weekday = date.getDay();
            const isWeekend = weekday === 0 || weekday === 6;
            const count = item ? Number(item['count']) : 0;
            const isWorkingDay = Boolean(item) && (!isWeekend || count >= 1);

            const cell = document.createElement(isWorkingDay ? 'button' : 'div');
            cell.className = 'day';
            if (isWorkingDay) {
              cell.type = 'button';
              cell.classList.add('interactive');
              cell.dataset.date = key;
              cell.addEventListener('click', () => openDetails(key, cell));
              if (hoverCapable.matches) {
                cell.addEventListener('pointerenter', () => scheduleHover(key, cell));
                cell.addEventListener('pointerleave', cancelHover);
              }
            }
            if (isWeekend) cell.classList.add('weekend');
            if (key === toDateKey(tokyoToday.year, tokyoToday.month, tokyoToday.day)) {
              cell.classList.add('today');
              cell.setAttribute('aria-current', 'date');
            }
            if (isWorkingDay) cell.classList.add(`level-${item.level}`);

            const number = document.createElement('span');
            number.className = 'date-number';
            number.textContent = day;

            if (isWorkingDay || !isWeekend) {
              const symbol = document.createElement('span');
              symbol.className = 'congestion-symbol';
              if (item) {
                symbol.textContent = item.symbol || LEVEL_SYMBOLS[item.level];
                cell.setAttribute(
                  'aria-label',
                  `${year}年${month}月${day}日、${symbol.textContent} ${FALLBACK_LEVELS[item.level].label}。詳細を表示`,
                );
              } else {
                symbol.textContent = '—';
                symbol.classList.add('no-data');
                cell.setAttribute('aria-label', `${year}年${month}月${day}日、データなし`);
              }
              cell.append(number, symbol);
            } else {
              cell.setAttribute('aria-label', `${year}年${month}月${day}日、休業日`);
              cell.appendChild(number);
            }
            elements.grid.appendChild(cell);
          }
        }

        function renderLegend(levels) {
          elements.legend.replaceChildren();
          levels.forEach((item) => {
            const entry = document.createElement('li');
            entry.className = 'legend-item';
            const color = document.createElement('span');
            color.className = 'legend-color';
            color.style.setProperty('--legend-color', LEVEL_COLORS[item.level]);
            if (item.level === 3) color.style.setProperty('--legend-ink', '#fff');
            color.textContent = item.symbol || LEVEL_SYMBOLS[item.level];
            const label = document.createElement('span');
            label.textContent = item.label;
            entry.append(color, label);
            elements.legend.appendChild(entry);
          });
        }

        function setLoading(loading) {
          isLoading = loading;
          elements.calendarWrap.setAttribute('aria-busy', String(loading));
          elements.spinner.hidden = !loading;
          if (loading) {
            elements.statusText.textContent = showingCachedCalendar
              ? '前回データを表示中（更新中…）'
              : hasLoadedSuccessfully
                ? '更新中…'
                : '読み込み中…';
          }
        }

        function formatUpdatedAt(value) {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return '更新日時不明';
          return `最終更新 ${new Intl.DateTimeFormat('ja-JP', {
            timeZone: TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(date)}`;
        }

        function chooseInitialMonth(days, replaceCachedMonth = false) {
          if ((!replaceCachedMonth && hasLoadedSuccessfully) || days.length === 0) return;
          const currentPrefix = `${tokyoToday.year}-${pad2(tokyoToday.month)}-`;
          if (days.some((day) => day.date.startsWith(currentPrefix))) return;

          const todayUtc = Date.UTC(tokyoToday.year, tokyoToday.month - 1, tokyoToday.day);
          const nearest = days.reduce((best, item) => {
            const distance = Math.abs(Date.parse(`${item.date}T00:00:00Z`) - todayUtc);
            return !best || distance < best.distance ? { item, distance } : best;
          }, null);
          if (nearest) {
            const [year, month] = nearest.item.date.split('-').map(Number);
            viewYear = year;
            viewMonth = month;
          }
        }

        function invalidateDetailCache() {
          detailGeneration += 1;
          detailCache.clear();
          detailPending.clear();
          cancelHover();
        }

        function getSafeErrorCode(response) {
          return response
            && response.error
            && (response.error.code === ERROR_CODES.accessDenied || response.error === ERROR_CODES.accessDenied)
            ? ERROR_CODES.accessDenied
            : ERROR_CODES.dataFetchFailed;
        }

        function hideSourceLink() {
          elements.sourceLink.hidden = true;
          elements.sourceLink.removeAttribute('href');
        }

        function showSourceLink(value) {
          try {
            const url = new URL(String(value || ''));
            if (
              url.protocol !== 'https:'
              || url.hostname !== 'docs.google.com'
              || !url.pathname.startsWith('/spreadsheets/d/')
            ) {
              hideSourceLink();
              return;
            }
            elements.sourceLink.href = url.href;
            elements.sourceLink.hidden = false;
          } catch (error) {
            hideSourceLink();
          }
        }

        function handleCalendarResponse(response) {
          markStartupTiming('getCalendarDataCompletedMs');
          if (!response || response.ok !== true || !response.data) {
            handleCalendarError(getSafeErrorCode(response));
            return;
          }

          const data = response.data;
          const days = Array.isArray(data.days) ? data.days : [];
          const levels = Array.isArray(data.levels) ? data.levels : FALLBACK_LEVELS;
          const wasShowingCachedCalendar = showingCachedCalendar;
          const nextDetailRevision = typeof data.detailRevision === 'string'
            ? data.detailRevision
            : null;
          const detailRevisionChanged = wasShowingCachedCalendar
            || (detailRevision !== null && detailRevision !== nextDetailRevision);
          detailRevision = nextDetailRevision;
          showingCachedCalendar = false;
          if (detailRevisionChanged) invalidateDetailCache();
          else cancelHover();
          chooseInitialMonth(days, wasShowingCachedCalendar);
          calendarData = new Map(days.map((day) => [day.date, day]));
          hasLoadedSuccessfully = true;
          showSourceLink(data.spreadsheetUrl);
          elements.error.hidden = true;
          elements.error.textContent = '';
          elements.statusText.textContent = formatUpdatedAt(data.updatedAt);
          renderLegend(levels);
          renderCalendar();
          saveCachedCalendar({ days, levels, updatedAt: data.updatedAt });
          setLoading(false);
          startupTiming.serverTiming = data.serverTiming || null;
          markStartupTiming('latestCalendarRenderedMs');
          if (startupTiming.latestCalendarRenderedMs !== null) {
            console.info('calendar startup timing', { ...startupTiming });
          }
          if (detailRevisionChanged) refreshOpenDetails();
        }

        function handleCalendarError(code) {
          const accessDenied = code === ERROR_CODES.accessDenied;
          if (accessDenied) {
            hideSourceLink();
            clearCachedCalendar();
            invalidateDetailCache();
            calendarData = new Map();
            hasLoadedSuccessfully = false;
            showingCachedCalendar = false;
            cancelHover();
            closeDetails();
            renderCalendar();
          }
          elements.error.textContent = accessDenied
            ? 'このページを表示する権限がありません。\nダンプロスケジュールへのアクセス権限を確認してください。'
            : 'データを取得できませんでした。しばらくしてから再度お試しください。';
          elements.error.hidden = false;
          elements.statusText.textContent = accessDenied
            ? 'アクセス権限がありません'
            : hasLoadedSuccessfully
              ? '前回取得したデータを表示中'
              : 'データを取得できませんでした';
          setLoading(false);
        }

        function handleCalendarFailure() {
          handleCalendarError(ERROR_CODES.dataFetchFailed);
        }

        async function refreshCalendar() {
          if (!sessionConfirmed || isLoading) return;
          setLoading(true);
          markStartupTiming('getCalendarDataStartedMs');
          try {
            handleCalendarResponse(await fetchJson('/api/calendar'));
          } catch (error) {
            if (error && (error.code === ERROR_CODES.unauthenticated || error.code === ERROR_CODES.accessDenied)) {
              showLogin(error.code === ERROR_CODES.accessDenied
                ? 'ダンプロスケジュールへのアクセス権限がありません。'
                : 'セッションの有効期限が切れました。もう一度ログインしてください。');
              return;
            }
            handleCalendarFailure();
          }
        }

        function loadDayDetails(dateKey) {
          if (detailCache.has(dateKey)) return Promise.resolve(detailCache.get(dateKey));
          if (detailPending.has(dateKey)) return detailPending.get(dateKey);

          const generation = detailGeneration;
          const requestedRevision = detailRevision;
          let request;
          request = fetchJson(`/api/day-details?date=${encodeURIComponent(dateKey)}&revision=${encodeURIComponent(requestedRevision || '')}`)
            .then((response) => {
                if (!response || response.ok !== true || !response.data) {
                  throw { code: getSafeErrorCode(response) };
                }
                const data = response.data;
                if (generation !== detailGeneration) {
                  throw { code: ERROR_CODES.dataFetchFailed };
                }
                const result = {
                  date: data.date === dateKey ? data.date : dateKey,
                  items: Array.isArray(data.items) ? data.items : [],
                  revision: typeof data.revision === 'string' ? data.revision : null,
                };
                if (!requestedRevision || result.revision === requestedRevision) {
                  detailCache.set(dateKey, result);
                }
                return result;
              })
            .catch((error) => {
              if (error && (error.code === ERROR_CODES.unauthenticated || error.code === ERROR_CODES.accessDenied)) {
                showLogin(error.code === ERROR_CODES.accessDenied
                  ? 'ダンプロスケジュールへのアクセス権限がありません。'
                  : 'セッションの有効期限が切れました。もう一度ログインしてください。');
              }
              throw error;
            })
            .finally(() => {
            if (detailPending.get(dateKey) === request) detailPending.delete(dateKey);
          });
          detailPending.set(dateKey, request);
          return request;
        }

        function renderDetailItems(items) {
          elements.detailBody.replaceChildren();
          if (items.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'detail-empty';
            empty.textContent = 'この日の予定はありません。';
            elements.detailBody.appendChild(empty);
            return;
          }

          const list = document.createElement('ul');
          list.className = 'detail-list';
          items.forEach((item) => {
            const card = document.createElement('li');
            card.className = 'detail-card';
            const subject = document.createElement('p');
            subject.className = 'detail-subject';
            const customer = String(item.customer || '').trim();
            const content = String(item.content || '').trim();
            subject.textContent = customer && content
              ? `${customer} / ${content}`
              : customer || content || '案件情報なし';

            const work = document.createElement('p');
            work.className = 'detail-work';
            const workText = String(item.work || '').trim() || '作業内容未設定';
            work.textContent = formatWorkWithPeriod(workText, item.period);
            card.append(subject, work);
            list.appendChild(card);
          });
          elements.detailBody.appendChild(list);
        }

        function formatPeriodLabel(period) {
          const normalized = String(period || '').trim().normalize('NFKC').toUpperCase();
          if (normalized === 'AM' || normalized === '午前') return '午前';
          if (normalized === 'PM' || normalized === '午後') return '午後';
          return '';
        }

        function formatWorkWithPeriod(work, period) {
          const periodLabel = formatPeriodLabel(period);
          return periodLabel ? `${work}（${periodLabel}）` : work;
        }

        function showDetailLoading() {
          elements.detailBody.replaceChildren();
          const loading = document.createElement('div');
          loading.className = 'detail-loading';
          loading.setAttribute('role', 'status');
          const spinner = document.createElement('span');
          spinner.className = 'detail-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          const text = document.createElement('span');
          text.textContent = '詳細を読み込み中…';
          loading.append(spinner, text);
          elements.detailBody.appendChild(loading);
        }

        function showDetailError(code) {
          elements.detailBody.replaceChildren();
          const error = document.createElement('p');
          error.className = 'detail-error';
          error.setAttribute('role', 'alert');
          error.textContent = code === ERROR_CODES.accessDenied
            ? '詳細情報を表示する権限がありません。'
            : '詳細情報を取得できませんでした。しばらくしてから再度お試しください。';
          elements.detailBody.appendChild(error);
        }

        async function openDetails(dateKey, trigger) {
          cancelHover();
          lastFocusedElement = trigger;
          activeModalDate = dateKey;
          const requestToken = ++modalRequestToken;
          elements.detailTitle.textContent = formatDateHeading(dateKey);
          elements.detailBackdrop.hidden = false;
          document.body.classList.add('modal-open');
          showDetailLoading();
          elements.detailClose.focus();

          try {
            const result = await loadDayDetails(dateKey);
            if (requestToken !== modalRequestToken || elements.detailBackdrop.hidden) return;
            renderDetailItems(result.items);
          } catch (error) {
            if (requestToken !== modalRequestToken || elements.detailBackdrop.hidden) return;
            showDetailError(error && error.code);
          }
        }

        async function refreshOpenDetails() {
          if (elements.detailBackdrop.hidden || !activeModalDate) return;
          const dateKey = activeModalDate;
          const requestToken = ++modalRequestToken;
          showDetailLoading();
          try {
            const result = await loadDayDetails(dateKey);
            if (requestToken !== modalRequestToken || elements.detailBackdrop.hidden) return;
            renderDetailItems(result.items);
          } catch (error) {
            if (requestToken !== modalRequestToken || elements.detailBackdrop.hidden) return;
            showDetailError(error && error.code);
          }
        }

        function closeDetails() {
          if (elements.detailBackdrop.hidden) return;
          modalRequestToken += 1;
          activeModalDate = null;
          elements.detailBackdrop.hidden = true;
          document.body.classList.remove('modal-open');
          if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
        }

        function previewLine(item) {
          const customer = String(item.customer || '').trim();
          const content = String(item.content || '').trim();
          const subject = customer || content || '案件';
          const work = String(item.work || '').trim() || '作業内容未設定';
          return `${subject}：${formatWorkWithPeriod(work, item.period)}`;
        }

        function positionPreview(anchor) {
          const rect = anchor.getBoundingClientRect();
          const preview = elements.hoverPreview;
          const gap = 8;
          const width = preview.offsetWidth;
          const height = preview.offsetHeight;
          let left = rect.left + (rect.width - width) / 2;
          left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
          let top = rect.bottom + gap;
          if (top + height > window.innerHeight - 8) top = rect.top - height - gap;
          preview.style.left = `${Math.max(8, left)}px`;
          preview.style.top = `${Math.max(8, top)}px`;
        }

        function showPreviewMessage(anchor, dateKey, message) {
          elements.hoverPreview.replaceChildren();
          const title = document.createElement('p');
          title.className = 'preview-title';
          title.textContent = formatDateHeading(dateKey);
          const body = document.createElement('div');
          body.textContent = message;
          elements.hoverPreview.append(title, body);
          elements.hoverPreview.hidden = false;
          positionPreview(anchor);
        }

        function renderPreview(anchor, dateKey, items) {
          elements.hoverPreview.replaceChildren();
          const title = document.createElement('p');
          title.className = 'preview-title';
          title.textContent = formatDateHeading(dateKey);
          elements.hoverPreview.appendChild(title);

          if (items.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '予定はありません。';
            elements.hoverPreview.appendChild(empty);
          } else {
            const list = document.createElement('ul');
            list.className = 'preview-list';
            items.slice(0, 5).forEach((item) => {
              const line = document.createElement('li');
              line.textContent = previewLine(item);
              list.appendChild(line);
            });
            if (items.length > 5) {
              const more = document.createElement('li');
              more.textContent = `ほか${items.length - 5}件`;
              list.appendChild(more);
            }
            elements.hoverPreview.appendChild(list);
          }
          elements.hoverPreview.hidden = false;
          positionPreview(anchor);
        }

        function scheduleHover(dateKey, anchor) {
          if (!hoverCapable.matches) return;
          window.clearTimeout(hoverTimer);
          const requestToken = ++hoverRequestToken;
          let settled = false;
          const request = loadDayDetails(dateKey).then(
            (result) => {
              settled = true;
              return { result };
            },
            (error) => {
              settled = true;
              return { error };
            },
          );
          hoverTimer = window.setTimeout(async () => {
            if (requestToken !== hoverRequestToken) return;
            if (!settled) showPreviewMessage(anchor, dateKey, '読み込み中…');
            const outcome = await request;
            if (requestToken !== hoverRequestToken) return;
            if (outcome.result) {
              renderPreview(anchor, dateKey, outcome.result.items);
            } else {
              showPreviewMessage(
                anchor,
                dateKey,
                outcome.error && outcome.error.code === ERROR_CODES.accessDenied
                  ? '概要を表示する権限がありません。'
                  : '概要を取得できませんでした。',
              );
            }
          }, HOVER_DELAY_MS);
        }

        function cancelHover() {
          window.clearTimeout(hoverTimer);
          hoverRequestToken += 1;
          elements.hoverPreview.hidden = true;
        }

        function moveMonth(offset) {
          const next = new Date(viewYear, viewMonth - 1 + offset, 1);
          viewYear = next.getFullYear();
          viewMonth = next.getMonth() + 1;
          cancelHover();
          renderCalendar();
        }

        elements.previousMonth.addEventListener('click', () => moveMonth(-1));
        elements.nextMonth.addEventListener('click', () => moveMonth(1));
        elements.today.addEventListener('click', () => {
          viewYear = tokyoToday.year;
          viewMonth = tokyoToday.month;
          cancelHover();
          renderCalendar();
        });
        elements.detailClose.addEventListener('click', closeDetails);
        elements.logout.addEventListener('click', async () => {
          elements.logout.disabled = true;
          try {
            await fetch('/api/auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
            });
          } finally {
            elements.logout.disabled = false;
            showLogin();
          }
        });
        elements.detailBackdrop.addEventListener('click', (event) => {
          if (event.target === elements.detailBackdrop) closeDetails();
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closeDetails();
        });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') refreshCalendar();
        });
        window.addEventListener('resize', cancelHover);
        window.addEventListener('scroll', cancelHover, { passive: true });

        async function boot() {
          renderLegend(FALLBACK_LEVELS);
          renderCalendar();
          try {
            const session = await fetchJson('/api/auth/session');
            if (!session || session.authenticated !== true) throw { code: ERROR_CODES.unauthenticated };
            showCalendar();
            restoreCachedCalendar();
            await refreshCalendar();
            refreshTimer = window.setInterval(refreshCalendar, REFRESH_INTERVAL_MS);
          } catch (error) {
            showLogin(error && error.code === ERROR_CODES.accessDenied
              ? 'ダンプロスケジュールへのアクセス権限がありません。'
              : 'Googleアカウントでログインしてください。');
          }
        }

        boot();
      })();
