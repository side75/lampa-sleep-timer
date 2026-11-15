// Lampa Sleep Timer — таймер сна в плеере Лампы
// Кнопка с луной на панели плеера: 15 / 30 / 45 / 60 / 90 минут или «до конца серии».
// Когда время выходит, плеер закрывается (позиция сохраняется как при обычном выходе) и экран затемняется,
// после чего устройство само уходит в сон по своей автоблокировке.
(function () {
    'use strict';

    if (window.lampa_sleep_timer_plugin) return;
    window.lampa_sleep_timer_plugin = true;

    var VERSION = '1.0.0';
    var MINUTES = [15, 30, 45, 60, 90];
    var WARN_SECONDS = 60;      // за сколько секунд предупреждать
    var EXTEND_MINUTES = 15;    // на сколько продлевает кнопка в предупреждении
    var END_GAP = 2;            // «до конца серии»: закрываем за столько секунд до конца, чтобы не включилась следующая

    var mode = 'off';           // 'off' | 'time' | 'episode'
    var deadline = 0;           // для mode === 'time'
    var ticker = null;
    var closedSeconds = 0;      // сколько секунд подряд плеер закрыт (переключение серии — пара секунд)
    var warnBox = null;
    var firing = false;

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em">' +
        '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

    function addStyles() {
        if (document.getElementById('sleep-timer-style')) return;
        var css = '' +
            '.sleep-timer-btn{position:relative}' +
            '.sleep-timer-btn.active{color:#ffd76a}' +
            '.sleep-timer-btn__left{position:absolute;top:-0.9em;left:50%;transform:translateX(-50%);font-size:0.75em;line-height:1;' +
                'background:rgba(0,0,0,0.65);border-radius:0.6em;padding:0.2em 0.5em;white-space:nowrap;color:#ffd76a;pointer-events:none}' +
            '.sleep-timer-warn{position:fixed;left:50%;top:8%;transform:translateX(-50%);z-index:100000;background:rgba(20,20,24,0.95);color:#fff;' +
                'border-radius:1em;padding:1em 1.4em;font-size:1.3em;text-align:center;box-shadow:0 0.5em 2em rgba(0,0,0,0.6);max-width:90%}' +
            '.sleep-timer-warn__btn{display:inline-block;margin-top:0.8em;padding:0.5em 1.2em;border-radius:2em;background:#fff;color:#000;font-weight:600;cursor:pointer}' +
            '.sleep-timer-dark{position:fixed;left:0;top:0;right:0;bottom:0;z-index:100001;background:#000;color:#333;display:flex;align-items:flex-end;' +
                'justify-content:center;padding-bottom:8%;font-size:1.1em;opacity:0;transition:opacity 1.5s}' +
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

        Lampa.Select.show({
            title: 'Таймер сна',
            items: items,
            onSelect: function (a) {
                if (a.off) stop(true);
                else if (a.episode) start('episode');
                else start('time', a.minutes);
                back();
            },
            onBack: back
        });
    }

    // ---------- логика таймера ----------

    function notify(text) {
        try { Lampa.Noty.show(text); } catch (e) {}
    }

    function start(newMode, minutes) {
        mode = newMode;
        deadline = newMode === 'time' ? Date.now() + minutes * 60000 : 0;
        closedSeconds = 0;
        hideWarn();
        if (!ticker) ticker = setInterval(tick, 1000);
        updateButtons();
        notify(newMode === 'time' ? 'Таймер сна: выключу через ' + minutes + ' мин' : 'Таймер сна: выключу в конце серии');
    }

    function stop(say) {
        mode = 'off';
        deadline = 0;
        clearInterval(ticker);
        ticker = null;
        hideWarn();
        updateButtons();
        if (say) notify('Таймер сна выключен');
    }

    function tick() {
        if (mode === 'off') return;

        // Вышли из плеера сами — значит не спите, таймер снимаем. Пара секунд без плеера — это переключение серии.
        if (!playerOpened()) {
            if (++closedSeconds >= 20) stop(false);
            return;
        }
        closedSeconds = 0;
        ensureButtons();

        if (mode === 'time') {
            var left = secondsLeft();
            if (left <= 0) return fire();
            if (left <= WARN_SECONDS) showWarn(left);
            updateButtons();
        }
    }

    // «До конца серии»: закрываем за пару секунд до конца, пока Лампа не включила следующую
    function onTimeUpdate(e) {
        if (mode !== 'episode' || firing || !e || !e.duration || !isFinite(e.duration)) return;
        if (e.duration > 30 && e.duration - e.current <= END_GAP) fire();
    }

    function showWarn(left) {
        if (!warnBox) {
            warnBox = $('<div class="sleep-timer-warn"><div class="sleep-timer-warn__text"></div>' +
                '<div class="sleep-timer-warn__btn selector">Ещё ' + EXTEND_MINUTES + ' минут</div></div>');
            warnBox.find('.sleep-timer-warn__btn').on('click hover:enter', function (ev) {
                ev.stopPropagation();
                extend();
            });
            $('body').append(warnBox);
        }
        warnBox.find('.sleep-timer-warn__text').text('Таймер сна: выключу через ' + fmt(left));
    }

    function hideWarn() {
        if (warnBox) { warnBox.remove(); warnBox = null; }
    }

    function extend() {
        if (mode !== 'time') return;
        deadline = Date.now() + EXTEND_MINUTES * 60000;
        hideWarn();
        updateButtons();
        notify('Таймер сна: ещё ' + EXTEND_MINUTES + ' мин');
    }

    // Пока висит предупреждение, любая кнопка пульта / клавиша OK продлевает таймер (на ТВ до кнопки не дотянуться)
    function onKey(e) {
        if (warnBox && (e.keyCode === 13 || e.keyCode === 29443 || e.keyCode === 65376)) {
            e.preventDefault();
            e.stopPropagation();
            extend();
        }
    }

    function fire() {
        if (firing) return;
        firing = true;
        stop(false);

        var dark = $('<div class="sleep-timer-dark"><div>Таймер сна сработал · коснитесь экрана, чтобы продолжить</div></div>');
        $('body').append(dark);
        setTimeout(function () { dark.addClass('show'); }, 30);

        // Лампа при закрытии плеера сама сохраняет позицию просмотра
        setTimeout(function () {
            try {
                if (Lampa.Select && Lampa.Select.opened && Lampa.Select.opened()) Lampa.Select.close();
            } catch (e) {}
            try { if (playerOpened()) Lampa.Player.close(); } catch (e) {}
            try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
            firing = false;
        }, 1600);

        var wake = function () {
            dark.remove();
            document.removeEventListener('keydown', wake, true);
        };
        dark.on('click touchstart', wake);
        setTimeout(function () { document.addEventListener('keydown', wake, true); }, 2500);
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
            Lampa.PlayerVideo.listener.follow('canplay', ensureButtons);
        }
        document.addEventListener('keydown', onKey, true);
        if (playerOpened()) ensureButtons();

        window.lampaSleepTimer = {
            version: VERSION,
            start: start,
            stop: function () { stop(true); },
            status: function () { return { mode: mode, left: Math.round(secondsLeft()), buttons: $('.sleep-timer-btn').length }; }
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
