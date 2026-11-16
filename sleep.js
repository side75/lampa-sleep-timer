// Lampa Sleep Timer — таймер сна в плеере Лампы
// Кнопка с луной на панели плеера: 15 / 30 / 45 / 60 / 90 минут или «до конца серии».
// Когда время выходит, видео сразу ставится на паузу, плеер закрывается (позиция сохраняется как при обычном выходе)
// и экран затемняется. Пока экран затемнён, сторож раз в секунду следит, чтобы ничего не играло:
// играющее (или зависшее на подгрузке) видео не даёт устройству уйти в сон по автоблокировке.
(function () {
    'use strict';

    if (window.lampa_sleep_timer_plugin) return;
    window.lampa_sleep_timer_plugin = true;

    var VERSION = '1.2.0';
    var MINUTES = [15, 30, 45, 60, 90];
    var cfg = {
        warn: 60,           // за сколько секунд предупреждать
        extend: 15,         // на сколько минут продлевает кнопка в предупреждении
        endGap: 2,          // «до конца серии»: срабатываем за столько секунд до конца, чтобы не включилась следующая
        stall: 180,         // видео не на паузе, но не двигается столько секунд — зависло, считаем, что зритель уснул
        ended: 30,          // видео закончилось и столько секунд ничего не началось — срабатываем
        overdue: 120,       // срок прошёл больше чем на столько секунд — устройство спало, таймер просто снимаем
        closeDelay: 1600,   // через сколько мс после затемнения закрывать плеер (пока экран плавно темнеет)
        lockDelay: 800,     // через сколько мс после закрытия плеера запускать команду блокировки (успевает сохраниться позиция)
        lockTest: 10,       // «Проверить блокировку»: через сколько секунд после нажатия запускать команду
        lockUi: false       // показывать пункты блокировки не только на устройствах Apple (для проверок)
    };
    var LOG_KEY = 'sleep_timer_log';
    var LOG_MAX = 40;
    var LOCK_KEY = 'sleep_timer_lock';
    var SHORTCUT = 'LampaLock';     // имя команды в приложении «Команды» с действием «Заблокировать экран»

    var mode = 'off';           // 'off' | 'time' | 'episode'
    var deadline = 0;           // для mode === 'time'
    var ticker = null;
    var closedSeconds = 0;      // сколько секунд подряд плеер закрыт (переключение серии — пара секунд)
    var warnBox = null;

    var sleeping = false;       // таймер сработал, экран затемнён
    var dark = null;
    var guard = null;           // сторож, пока экран затемнён
    var closeTimer = null;
    var guardNotes = 0;

    var lastPos = -1;           // слежение за зависшим видео
    var stuckSeconds = 0;
    var endedSeconds = 0;

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em">' +
        '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

    function addStyles() {
        if (document.getElementById('sleep-timer-style')) return;
        var css = '' +
            '.sleep-timer-btn{position:relative}' +
            '.sleep-timer-btn.active{color:#ffd76a}' +
            '.sleep-timer-btn__left{position:absolute;top:-0.9em;left:50%;transform:translateX(-50%);font-size:0.75em;line-height:1;' +
                'background:rgba(0,0,0,0.65);border-radius:0.6em;padding:0.2em 0.5em;white-space:nowrap;color:#ffd76a;pointer-events:none}' +
            '.sleep-timer-warn{pointer-events:auto;position:fixed;left:50%;top:8%;transform:translateX(-50%);z-index:100000;background:rgba(20,20,24,0.95);color:#fff;' +
                'border-radius:1em;padding:1em 1.4em;font-size:1.3em;text-align:center;box-shadow:0 0.5em 2em rgba(0,0,0,0.6);max-width:90%}' +
            '.sleep-timer-warn__btn{display:inline-block;margin-top:0.8em;padding:0.5em 1.2em;border-radius:2em;background:#fff;color:#000;font-weight:600;cursor:pointer}' +
            '.sleep-timer-dark{pointer-events:auto;position:fixed;left:0;top:0;right:0;bottom:0;z-index:100001;background:#000;color:#333;display:flex;align-items:flex-end;' +
                'justify-content:center;padding-bottom:8%;font-size:1.1em;opacity:0;transition:opacity 1.5s;cursor:pointer}' +
            '.sleep-timer-dark.show{opacity:1}';
        var st = document.createElement('style');
        st.id = 'sleep-timer-style';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function playerOpened() {
        try { return !!(Lampa.Player && Lampa.Player.opened && Lampa.Player.opened()); } catch (e) { return false; }
    }

    function fmt(sec) {
        sec = Math.max(0, Math.round(sec));
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        if (m >= 60) return Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60) + ':' + (s < 10 ? '0' : '') + s;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function secondsLeft() {
        return mode === 'time' ? (deadline - Date.now()) / 1000 : 0;
    }

    // ---------- журнал: что и когда делал таймер (хранится на устройстве, виден в меню таймера) ----------

    function readLog() {
        try {
            var a = JSON.parse(window.localStorage.getItem(LOG_KEY) || '[]');
            return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
        } catch (e) { return []; }
    }

    function note(text) {
        try {
            var a = readLog();
            a.push([Date.now(), String(text)]);
            if (a.length > LOG_MAX) a = a.slice(a.length - LOG_MAX);
            window.localStorage.setItem(LOG_KEY, JSON.stringify(a));
        } catch (e) {}
        try { console.log('[SleepTimer]', text); } catch (e) {}
    }

    function two(n) { return (n < 10 ? '0' : '') + n; }

    function stamp(ts) {
        var d = new Date(ts);
        return two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    }

    // ---------- видео ----------

    function playerVideo() {
        try {
            var v = Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video();
            return v && typeof v.pause === 'function' ? v : null;
        } catch (e) { return null; }
    }

    function position() {
        var v = playerVideo();
        try { if (v && v.duration && isFinite(v.duration)) return fmt(v.currentTime) + ' из ' + fmt(v.duration); } catch (e) {}
        return '';
    }

    function mediaList() {
        var out = [];
        try {
            var nodes = document.querySelectorAll('video, audio');
            for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
        } catch (e) {}
        var pv = playerVideo();
        if (pv && out.indexOf(pv) === -1) out.push(pv);
        return out;
    }

    // Ставит на паузу всё, что не на паузе (в том числе зависшее на подгрузке). Возвращает, сколько остановил.
    function pauseAll() {
        var n = 0;
        var list = mediaList();
        for (var i = 0; i < list.length; i++) {
            try {
                if (!list[i].paused && !list[i].ended) { list[i].pause(); n++; }
            } catch (e) {}
        }
        return n;
    }

    // Лампа сначала закрывает окно «информация о воспроизведении» и только со второго вызова — сам плеер
    function closePlayer() {
        for (var i = 0; i < 3 && playerOpened(); i++) {
            try { Lampa.Player.close(); } catch (e) { guardNote('ошибка при закрытии плеера: ' + (e && e.message ? e.message : e)); break; }
        }
        return !playerOpened();
    }

    // Плеер не закрылся — хотя бы отцепляем поток, чтобы видео не удерживало экран
    function hardStop() {
        try { if (Lampa.PlayerVideo && Lampa.PlayerVideo.destroy) Lampa.PlayerVideo.destroy(); } catch (e) {}
        var list = mediaList();
        for (var i = 0; i < list.length; i++) {
            try {
                list[i].pause();
                if (list[i].removeAttribute) { list[i].removeAttribute('src'); list[i].load(); }
            } catch (e) {}
        }
    }

    // Заставка Лампы (по умолчанию — видео) запускается через 5 минут простоя; под затемнением она не нужна
    function screensaver(on) {
        try {
            var s = Lampa.Screensaver;
            if (!s) return;
            if (on) { if (s.enable) s.enable(); }
            else {
                if (s.isWorked && s.isWorked() && s.stop) s.stop();
                if (s.disable) s.disable();
            }
        } catch (e) {}
    }

    // ---------- настоящая блокировка iPad / iPhone через приложение «Команды» ----------
    // Веб-страница сама заблокировать устройство не может, но может открыть ссылку на команду,
    // в которой одно действие — «Заблокировать экран».

    function isApple() {
        if (cfg.lockUi) return true;
        try { return /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 0; } catch (e) { return false; }
    }

    function lockEnabled() {
        try { return isApple() && window.localStorage.getItem(LOCK_KEY) === '1'; } catch (e) { return false; }
    }

    function setLock(on) {
        try { window.localStorage.setItem(LOCK_KEY, on ? '1' : '0'); } catch (e) {}
        note(on ? 'блокировка планшета включена' : 'блокировка планшета выключена');
    }

    function lockDevice(src, say) {
        note('запускаю команду ' + SHORTCUT + ': ' + src);
        try { window.location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT); }
        catch (e) { note('команду запустить не удалось: ' + (e && e.message ? e.message : e)); }
        // Если устройство ушло в «Команды», страница становится скрытой и этот таймер досчитает уже после разблокировки
        var at = Date.now();
        setTimeout(function () {
            var hidden = false;
            try { hidden = document.visibilityState === 'hidden'; } catch (e) {}
            if (hidden || Date.now() - at > 8000) note('команда запущена, планшет ушёл из Лампы');
            else {
                note('команда НЕ запустилась: Лампа осталась на экране');
                if (say) notify('Команда ' + SHORTCUT + ' не запустилась');
            }
        }, 4000);
    }

    // ---------- кнопка на панели плеера ----------

    function panelRoot() {
        try { if (Lampa.PlayerPanel && Lampa.PlayerPanel.render) return Lampa.PlayerPanel.render(); } catch (e) {}
        return $('.player-panel');
    }

    function ensureButtons() {
        var root = panelRoot();
        if (!root || !root.length) return;
        // обычная раскладка (ТВ/ПК) и мобильная — в каждой свой правый блок кнопок
        root.find('.player-panel__right').each(function () {
            var right = $(this);
            if (right.find('.sleep-timer-btn').length) return;
            var box = right.find('.player-panel__box-buttons').last();
            if (!box.length) return;
            var btn = $('<div class="player-panel__sleep sleep-timer-btn button selector">' + ICON + '<div class="sleep-timer-btn__left hide"></div></div>');
            btn.on('hover:enter', openMenu);
            box.prepend(btn);
        });
        updateButtons();
    }

    function updateButtons() {
        var btns = $('.sleep-timer-btn');
        if (!btns.length) return;
        btns.toggleClass('active', mode !== 'off');
        var label = btns.find('.sleep-timer-btn__left');
        if (mode === 'time') label.text(fmt(secondsLeft())).removeClass('hide');
        else if (mode === 'episode') label.text('до конца').removeClass('hide');
        else label.addClass('hide');
    }

    function openMenu() {
        var enabled = 'player_panel';
        try { enabled = Lampa.Controller.enabled().name || enabled; } catch (e) {}
        if (enabled === 'select') enabled = 'player_panel'; // меню уже было открыто — возвращаемся на панель плеера
        var back = function () { try { Lampa.Controller.toggle(enabled); } catch (e) {} };

        var items = [];
        if (mode !== 'off') {
            items.push({ title: 'Выключить таймер', subtitle: mode === 'time' ? 'Осталось ' + fmt(secondsLeft()) : 'Сейчас: до конца серии', off: true });
        }
        for (var i = 0; i < MINUTES.length; i++) {
            items.push({ title: 'Через ' + MINUTES[i] + ' мин', minutes: MINUTES[i] });
        }
        items.push({ title: 'До конца серии', subtitle: 'Следующая серия не включится', episode: true });
        if (isApple()) {
            items.push({
                title: 'Блокировать планшет: ' + (lockEnabled() ? 'да' : 'нет'),
                subtitle: 'Нужна команда ' + SHORTCUT + ' в приложении «Команды»',
                lockToggle: true
            });
            items.push({ title: 'Проверить блокировку', subtitle: 'Запустит команду через ' + cfg.lockTest + ' секунд', lockTest: true });
        }
        items.push({ title: 'Журнал таймера', subtitle: 'Что и когда он делал', log: true });

        Lampa.Select.show({
            title: 'Таймер сна',
            items: items,
            onSelect: function (a) {
                if (a.log) return openLog(back);
                if (a.lockToggle) {
                    setLock(!lockEnabled());
                    notify(lockEnabled() ? 'Таймер сна будет блокировать планшет' : 'Таймер сна не будет блокировать планшет');
                    return back();
                }
                if (a.lockTest) {
                    notify('Через ' + cfg.lockTest + ' секунд запущу команду ' + SHORTCUT + '. Не трогайте планшет');
                    setTimeout(function () { lockDevice('проверка', true); }, cfg.lockTest * 1000);
                    return back();
                }
                if (a.off) stop(true);
                else if (a.episode) start('episode');
                else start('time', a.minutes);
                back();
            },
            onBack: back
        });
    }

    function openLog(back) {
        var a = readLog();
        var items = [];
        for (var i = a.length - 1; i >= 0; i--) items.push({ title: a[i][1], subtitle: stamp(a[i][0]) });
        if (!items.length) items.push({ title: 'Пока пусто' });
        Lampa.Select.show({ title: 'Журнал таймера', items: items, onSelect: back, onBack: back });
    }

    // ---------- логика таймера ----------

    function notify(text) {
        try { Lampa.Noty.show(text); } catch (e) {}
    }

    function start(newMode, minutes) {
        mode = newMode;
        deadline = newMode === 'time' ? Date.now() + minutes * 60000 : 0;
        closedSeconds = 0;
        lastPos = -1;
        stuckSeconds = 0;
        endedSeconds = 0;
        hideWarn();
        if (!ticker) ticker = setInterval(tick, 1000);
        updateButtons();
        note(newMode === 'time' ? 'поставлен на ' + minutes + ' мин' : 'поставлен до конца серии');
        notify(newMode === 'time' ? 'Таймер сна: выключу через ' + minutes + ' мин' : 'Таймер сна: выключу в конце серии');
    }

    function stop(say) {
        mode = 'off';
        deadline = 0;
        clearInterval(ticker);
        ticker = null;
        hideWarn();
        updateButtons();
        if (say) { note('выключен вручную'); notify('Таймер сна выключен'); }
    }

    function tick() {
        if (mode === 'off') return;

        // Вышли из плеера сами — значит не спите, таймер снимаем. Пара секунд без плеера — это переключение серии.
        if (!playerOpened()) {
            if (++closedSeconds >= 20) { note('снят: плеер закрыт'); stop(false); }
            return;
        }
        closedSeconds = 0;
        ensureButtons();

        if (watchVideo()) return;

        if (mode === 'time') {
            var left = secondsLeft();
            // Устройство само заснуло раньше срока и его разбудили позже — затемнять экран уже незачем
            if (left < -cfg.overdue) { note('снят: срок прошёл, пока устройство спало'); stop(false); return; }
            if (left <= 0) return fire('вышло время');
            if (left <= cfg.warn) showWarn(left);
            updateButtons();
        }
    }

    // Зависшее видео не стоит на паузе и поэтому не даёт устройству заснуть — само оно не остановится никогда
    function watchVideo() {
        var v = playerVideo();
        if (!v) { lastPos = -1; stuckSeconds = 0; endedSeconds = 0; return false; }
        var pos = -1;
        try { pos = Number(v.currentTime) || 0; } catch (e) {}

        if (v.ended) {
            stuckSeconds = 0;
            if (++endedSeconds >= cfg.ended) { fire('серия закончилась, следующая не началась'); return true; }
        } else {
            endedSeconds = 0;
            if (!v.paused && pos === lastPos) {
                if (++stuckSeconds >= cfg.stall) { fire('видео зависло и не двигалось ' + fmt(stuckSeconds)); return true; }
            } else stuckSeconds = 0;
        }
        lastPos = pos;
        return false;
    }

    // «До конца серии»: останавливаем за пару секунд до конца, пока Лампа не включила следующую
    function onTimeUpdate(e) {
        if (mode !== 'episode' || sleeping || !e || !e.duration || !isFinite(e.duration)) return;
        if (e.duration > 30 && e.duration - e.current <= cfg.endGap) fire('конец серии');
    }

    // Запасной путь: конец серии наступил раньше, чем ожидалось по длительности
    function onEnded() {
        if (mode === 'episode' && !sleeping) fire('конец серии');
    }

    function showWarn(left) {
        if (!warnBox) {
            warnBox = $('<div class="sleep-timer-warn"><div class="sleep-timer-warn__text"></div>' +
                '<div class="sleep-timer-warn__btn">Ещё ' + cfg.extend + ' минут</div></div>');
            // Продлевает только настоящее нажатие человека, а не событие, которое прислал чужой код
            warnBox.find('.sleep-timer-warn__btn')[0].addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (ev.isTrusted !== false) extend('касание');
            });
            $('body').append(warnBox);
            note('предупреждение показано');
        }
        warnBox.find('.sleep-timer-warn__text').text('Таймер сна: выключу через ' + fmt(left));
    }

    function hideWarn() {
        if (warnBox) { warnBox.remove(); warnBox = null; }
    }

    function extend(src) {
        if (mode !== 'time') return;
        deadline = Date.now() + cfg.extend * 60000;
        hideWarn();
        updateButtons();
        note('продлён на ' + cfg.extend + ' мин: ' + src);
        notify('Таймер сна: ещё ' + cfg.extend + ' мин');
    }

    // Пока висит предупреждение, кнопка OK на пульте продлевает таймер (на ТВ до кнопки не дотянуться)
    function onKey(e) {
        if (!warnBox || sleeping) return;
        if (e.keyCode === 13 || e.keyCode === 29443 || e.keyCode === 65376) {
            if (e.isTrusted === false || e.repeat) return;
            e.preventDefault();
            e.stopPropagation();
            extend('кнопка OK');
        }
    }

    // ---------- срабатывание ----------

    function guardNote(text) {
        if (guardNotes++ < 8) note(text);
    }

    // Вызывается сторожем каждую секунду, пока экран затемнён
    function enforce() {
        var n = pauseAll();
        if (playerOpened()) {
            try { if (Lampa.Select && Lampa.Select.opened && Lampa.Select.opened()) Lampa.Select.close(); } catch (e) {}
            if (closePlayer()) guardNote('плеер закрыт');
            else { hardStop(); guardNote('плеер не закрылся — поток остановлен принудительно'); }
        } else if (n) {
            guardNote('остановлено видео: ' + n);
        }
    }

    function fire(reason) {
        if (sleeping) return;
        sleeping = true;
        guardNotes = 0;

        var pos = position();
        note('сработал: ' + reason + (pos ? ' · ' + pos : ''));
        stop(false);

        // Пауза сразу: видео на паузе не удерживает экран и не доиграет до конца, так что следующая серия не включится
        pauseAll();
        screensaver(false);

        dark = $('<div class="sleep-timer-dark"><div>Таймер сна сработал · коснитесь экрана, чтобы продолжить</div></div>');
        $('body').append(dark);
        setTimeout(function () { if (dark) dark.addClass('show'); }, 30);
        dark.on('click touchend', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            wake('касание');
        });

        // Плеер закрываем, когда экран уже потемнел. Лампа при закрытии сама сохраняет позицию просмотра.
        closeTimer = setTimeout(function () {
            closeTimer = null;
            if (!sleeping) return;
            enforce();
            try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
            if (lockEnabled()) setTimeout(function () { if (sleeping) lockDevice('таймер сработал', false); }, cfg.lockDelay);
        }, cfg.closeDelay);

        // Сторож: всё, что заиграет под затемнением (следующая серия, заставка), сразу останавливается
        guard = setInterval(function () {
            if (!sleeping) return;
            if (closeTimer) pauseAll();
            else enforce();
        }, 1000);

        setTimeout(function () { if (sleeping) document.addEventListener('keydown', onWakeKey, true); }, 2500);
    }

    function onWakeKey(e) {
        e.preventDefault();
        e.stopPropagation();
        wake('кнопка');
    }

    function wake(src) {
        if (!sleeping) return;
        sleeping = false;
        clearInterval(guard);
        guard = null;
        clearTimeout(closeTimer);
        closeTimer = null;
        document.removeEventListener('keydown', onWakeKey, true);
        if (dark) { dark.remove(); dark = null; }
        screensaver(true);
        note('экран разбужен: ' + src);
    }

    // ---------- запуск ----------

    function init() {
        if (window.lampa_sleep_timer_ready) return;
        window.lampa_sleep_timer_ready = true;
        addStyles();

        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start', function () { setTimeout(ensureButtons, 300); });
            Lampa.Player.listener.follow('ready', function () { setTimeout(ensureButtons, 300); });
        }
        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('timeupdate', onTimeUpdate);
            Lampa.PlayerVideo.listener.follow('ended', onEnded);
            Lampa.PlayerVideo.listener.follow('canplay', ensureButtons);
        }
        document.addEventListener('keydown', onKey, true);
        if (playerOpened()) ensureButtons();

        window.lampaSleepTimer = {
            version: VERSION,
            start: start,
            stop: function () { stop(true); },
            wake: function () { wake('команда'); },
            log: readLog,
            status: function () {
                return { mode: mode, left: Math.round(secondsLeft()), sleeping: sleeping, stuck: stuckSeconds, lock: lockEnabled(), buttons: $('.sleep-timer-btn').length };
            },
            // для проверок: позволяет укоротить пороги
            _cfg: function (o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(cfg, k)) cfg[k] = o[k]; return cfg; }
        };
        try { console.log('[SleepTimer] v' + VERSION + ' started'); } catch (e) {}
    }

    if (window.appready) init();
    else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
    } else {
        var wait = setInterval(function () { if (window.appready) { clearInterval(wait); init(); } }, 500);
    }
})();
