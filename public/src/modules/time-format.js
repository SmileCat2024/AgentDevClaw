// Calendar groups use local dates; elapsed-minute labels use elapsed time.
// Keep these distinct across midnight and daylight-saving transitions.
export function getTimeOfDayLabel(hour, isZh) {
  if (isZh) {
    if (hour < 6) return '凌晨';
    if (hour < 12) return '上午';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
  }
  return hour < 12 ? 'AM' : 'PM';
}

export function createTimeFormat(getLanguage, Clock = Date) {
  function formatWorkspaceDate(isoString) {
    if (!isoString) return '-';
    const date = new Clock(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
  }

  function calendarDifference(now, date) {
    const today0 = new Clock(now.getFullYear(), now.getMonth(), now.getDate());
    const date0 = new Clock(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((today0.getTime() - date0.getTime()) / 86400000);
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const date = new Clock(isoString);
    if (Number.isNaN(date.getTime())) return '';
    const isZh = getLanguage() === 'zh';
    const now = new Clock();
    const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (minutes < 1) return isZh ? '刚刚' : 'just now';
    if (minutes < 60) return isZh ? minutes + '分钟前' : minutes + 'm ago';
    const hour = date.getHours();
    const hour12 = String(hour % 12 || 12);
    const todZh = getTimeOfDayLabel(hour, true);
    const todEn = getTimeOfDayLabel(hour, false);
    const days = calendarDifference(now, date);
    if (days === 0) return isZh ? '今天' + todZh + hour12 + '点' : 'Today ' + hour12 + todEn;
    if (days === 1) return isZh ? '昨天' + todZh + hour12 + '点' : 'Yesterday ' + hour12 + todEn;
    if (days === 2) return isZh ? '前天' + todZh + hour12 + '点' : '2 days ago ' + hour12 + todEn;
    if (days >= 3 && days <= 6) {
      const weekdays = isZh ? ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
        : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return weekdays[date.getDay()] + ' ' + (isZh ? todZh + hour12 + '点' : hour12 + todEn);
    }
    if (date.getFullYear() === now.getFullYear()) {
      return isZh ? (date.getMonth() + 1) + '月' + date.getDate() + '日'
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return isZh ? date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日'
      : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function getTimeGroupLabel(isoString) {
    if (!isoString) return '';
    const date = new Clock(isoString);
    if (Number.isNaN(date.getTime())) return '';
    const zh = getLanguage() === 'zh';
    const days = calendarDifference(new Clock(), date);
    if (days <= 0) return zh ? '今天' : 'Today';
    if (days === 1) return zh ? '昨天' : 'Yesterday';
    if (days === 2) return zh ? '前天' : 'Day Before';
    if (days <= 6) return zh ? '本周' : 'This Week';
    return zh ? '更早' : 'Earlier';
  }

  function getSessionRecencyClass(isoString) {
    if (!isoString) return 'older';
    const date = new Clock(isoString);
    if (Number.isNaN(date.getTime())) return 'older';
    const now = new Clock();
    if (Math.floor((now.getTime() - date.getTime()) / 60000) < 60) return 'just-now';
    const days = calendarDifference(now, date);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days === 2) return 'day-before';
    if (days <= 6) return 'this-week';
    return 'older';
  }

  function getSessionShortTime(isoString) {
    if (!isoString) return '';
    const date = new Clock(isoString);
    if (Number.isNaN(date.getTime())) return '';
    const zh = getLanguage() === 'zh';
    const now = new Clock();
    const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (minutes < 1) return zh ? '刚刚' : 'now';
    if (minutes < 60) return zh ? minutes + '分钟' : minutes + 'm';
    const days = calendarDifference(now, date);
    const hour = date.getHours();
    const hour12 = String(hour % 12 || 12);
    const tod = getTimeOfDayLabel(hour, zh);
    if (days <= 0) return zh ? tod + hour12 + '点' : hour12 + tod;
    if (days === 1) return zh ? '昨天' + tod : 'Yest ' + tod;
    if (days === 2) return zh ? '前天' + tod : '2d ' + tod;
    if (days <= 6) return zh ? '周' + '日一二三四五六'[date.getDay()] + tod
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()] + ' ' + tod;
    return '';
  }

  return { formatWorkspaceDate, formatRelativeTime, getTimeGroupLabel, getSessionRecencyClass, getSessionShortTime };
}
