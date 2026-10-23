import { useEffect, useReducer } from "react";

// Lightweight, dependency-free i18n foundation.
//
// WHY not react-intl/next-intl: those are excellent but add a build+provider layer.
// This gives the same core capability with a tiny surface: string catalogs + a t()
// lookup + a reactive useT() hook (pub/sub so components re-render on a language
// change with NO app-wide provider). The active language is driven by the
// Settings › Language & Region picker (CoLabV1.applySettings → setLang).
//
// COVERAGE: this catalog currently localizes the highest-visibility chrome (the Rail
// navigation + a few common labels) across the languages below. To localize another
// surface, add its keys to every catalog and swap the literal for t("key", "English
// fallback") in that component — the fallback keeps English showing for any key a
// catalog hasn't translated yet, so partial coverage never shows a raw key.

export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["pt", "Português"],
  ["hi", "हिन्दी"],
  ["zh", "中文"],
  ["ja", "日本語"],
  ["ru", "Русский"],
  ["ko", "한국어"],
];

// Direction per language. Every supported language is left-to-right — Arabic (and
// full product RTL/bidi mirroring) was intentionally left out: it needs a
// dedicated logical-property CSS pass, not just string translation. Kept as a
// helper so a future RTL language + its CSS work can flip <html dir> cleanly.
export const RTL_LANGS = new Set<string>([]);
export function dirFor(lang: string): "rtl" | "ltr" {
  return RTL_LANGS.has(lang) ? "rtl" : "ltr";
}

type Dict = Record<string, string>;

const CATALOGS: Record<string, Dict> = {
  en: {
    "nav.dashboard": "Dashboard",
    "nav.activity": "Activity",
    "nav.search": "Search",
    "nav.chats": "Messages",
    "nav.agents": "Agents",
    "nav.files": "Files",
    "nav.meetings": "Meetings",
    "nav.calls": "Calls",
    "nav.contacts": "Contacts",
    "nav.tasks": "Tasks",
    "nav.reminders": "Reminders",
    "nav.calendar": "Calendar",
    "common.settings": "Settings",
    "common.help": "Help",
    "common.logout": "Sign out",
    "common.download": "Download app",
    "common.checkUpdates": "Check for updates",
    "common.updateAvailable": "Update available",
    "common.close": "Close",
    "group.workspace": "Workspace",
    "group.operations": "Operations",
    "settings.title": "Settings",
    "settings.notif": "Notifications",
    "settings.accessibility": "Accessibility",
    "settings.region": "Language & Region",
    "settings.security": "Security",
    "settings.activity": "Activity log",
    "settings.devices": "Devices",
    "settings.privacy": "Privacy",
    "settings.safety": "Safety",
    "settings.mobile": "Mobile App",
    "settings.developer": "Developer options",
    "settings.profile": "Profile",
    "settings.appearance": "Appearance",
    "region.title": "Language & Region",
    "region.language": "Language",
    "region.timezone": "Timezone",
    "region.dateFormat": "Date Format",
    "region.timeFormat": "Time Format",
  },
  es: {
    "nav.dashboard": "Panel",
    "nav.activity": "Actividad",
    "nav.search": "Buscar",
    "nav.chats": "Mensajes",
    "nav.agents": "Agentes",
    "nav.files": "Archivos",
    "nav.meetings": "Reuniones",
    "nav.calls": "Llamadas",
    "nav.contacts": "Contactos",
    "nav.tasks": "Tareas",
    "nav.reminders": "Recordatorios",
    "nav.calendar": "Calendario",
    "common.settings": "Ajustes",
    "common.help": "Ayuda",
    "common.logout": "Cerrar sesión",
    "common.download": "Descargar app",
    "common.checkUpdates": "Buscar actualizaciones",
    "common.updateAvailable": "Actualización disponible",
    "common.close": "Cerrar",
    "group.workspace": "Espacio de trabajo",
    "group.operations": "Operaciones",
    "settings.title": "Ajustes",
    "settings.notif": "Notificaciones",
    "settings.accessibility": "Accesibilidad",
    "settings.region": "Idioma y región",
    "settings.security": "Seguridad",
    "settings.activity": "Registro de actividad",
    "settings.devices": "Dispositivos",
    "settings.privacy": "Privacidad",
    "settings.safety": "Protección",
    "settings.mobile": "Aplicación móvil",
    "settings.developer": "Opciones de desarrollador",
    "settings.profile": "Perfil",
    "settings.appearance": "Apariencia",
    "region.title": "Idioma y región",
    "region.language": "Idioma",
    "region.timezone": "Zona horaria",
    "region.dateFormat": "Formato de fecha",
    "region.timeFormat": "Formato de hora",
  },
  fr: {
    "nav.dashboard": "Tableau de bord",
    "nav.activity": "Activité",
    "nav.search": "Rechercher",
    "nav.chats": "Messages",
    "nav.agents": "Agents",
    "nav.files": "Fichiers",
    "nav.meetings": "Réunions",
    "nav.calls": "Appels",
    "nav.contacts": "Contacts",
    "nav.tasks": "Tâches",
    "nav.reminders": "Rappels",
    "nav.calendar": "Calendrier",
    "common.settings": "Paramètres",
    "common.help": "Aide",
    "common.logout": "Se déconnecter",
    "common.download": "Télécharger l'app",
    "common.checkUpdates": "Rechercher des mises à jour",
    "common.updateAvailable": "Mise à jour disponible",
    "common.close": "Fermer",
    "group.workspace": "Espace de travail",
    "group.operations": "Opérations",
    "settings.title": "Paramètres",
    "settings.notif": "Notifications",
    "settings.accessibility": "Accessibilité",
    "settings.region": "Langue et région",
    "settings.security": "Sécurité",
    "settings.activity": "Journal d'activité",
    "settings.devices": "Appareils",
    "settings.privacy": "Confidentialité",
    "settings.safety": "Sûreté",
    "settings.mobile": "Application mobile",
    "settings.developer": "Options pour développeurs",
    "settings.profile": "Profil",
    "settings.appearance": "Apparence",
    "region.title": "Langue et région",
    "region.language": "Langue",
    "region.timezone": "Fuseau horaire",
    "region.dateFormat": "Format de date",
    "region.timeFormat": "Format d'heure",
  },
  de: {
    "nav.dashboard": "Übersicht",
    "nav.activity": "Aktivität",
    "nav.search": "Suche",
    "nav.chats": "Nachrichten",
    "nav.agents": "Agenten",
    "nav.files": "Dateien",
    "nav.meetings": "Besprechungen",
    "nav.calls": "Anrufe",
    "nav.contacts": "Kontakte",
    "nav.tasks": "Aufgaben",
    "nav.reminders": "Erinnerungen",
    "nav.calendar": "Kalender",
    "common.settings": "Einstellungen",
    "common.help": "Hilfe",
    "common.logout": "Abmelden",
    "common.download": "App herunterladen",
    "common.checkUpdates": "Nach Updates suchen",
    "common.updateAvailable": "Update verfügbar",
    "common.close": "Schließen",
    "group.workspace": "Arbeitsbereich",
    "group.operations": "Betrieb",
    "settings.title": "Einstellungen",
    "settings.notif": "Benachrichtigungen",
    "settings.accessibility": "Barrierefreiheit",
    "settings.region": "Sprache & Region",
    "settings.security": "Sicherheit",
    "settings.activity": "Aktivitätsprotokoll",
    "settings.devices": "Geräte",
    "settings.privacy": "Datenschutz",
    "settings.safety": "Schutz",
    "settings.mobile": "Mobile App",
    "settings.developer": "Entwickleroptionen",
    "settings.profile": "Profil",
    "settings.appearance": "Darstellung",
    "region.title": "Sprache & Region",
    "region.language": "Sprache",
    "region.timezone": "Zeitzone",
    "region.dateFormat": "Datumsformat",
    "region.timeFormat": "Zeitformat",
  },
  pt: {
    "nav.dashboard": "Painel",
    "nav.activity": "Atividade",
    "nav.search": "Buscar",
    "nav.chats": "Mensagens",
    "nav.agents": "Agentes",
    "nav.files": "Arquivos",
    "nav.meetings": "Reuniões",
    "nav.calls": "Chamadas",
    "nav.contacts": "Contatos",
    "nav.tasks": "Tarefas",
    "nav.reminders": "Lembretes",
    "nav.calendar": "Calendário",
    "common.settings": "Configurações",
    "common.help": "Ajuda",
    "common.logout": "Sair",
    "common.download": "Baixar app",
    "common.checkUpdates": "Verificar atualizações",
    "common.updateAvailable": "Atualização disponível",
    "common.close": "Fechar",
    "group.workspace": "Espaço de trabalho",
    "group.operations": "Operações",
    "settings.title": "Configurações",
    "settings.notif": "Notificações",
    "settings.accessibility": "Acessibilidade",
    "settings.region": "Idioma e região",
    "settings.security": "Segurança",
    "settings.activity": "Registro de atividades",
    "settings.devices": "Dispositivos",
    "settings.privacy": "Privacidade",
    "settings.safety": "Proteção",
    "settings.mobile": "Aplicativo móvel",
    "settings.developer": "Opções de desenvolvedor",
    "settings.profile": "Perfil",
    "settings.appearance": "Aparência",
    "region.title": "Idioma e região",
    "region.language": "Idioma",
    "region.timezone": "Fuso horário",
    "region.dateFormat": "Formato de data",
    "region.timeFormat": "Formato de hora",
  },
  hi: {
    "nav.dashboard": "डैशबोर्ड",
    "nav.activity": "गतिविधि",
    "nav.search": "खोजें",
    "nav.chats": "संदेश",
    "nav.agents": "एजेंट",
    "nav.files": "फ़ाइलें",
    "nav.meetings": "मीटिंग",
    "nav.calls": "कॉल",
    "nav.contacts": "संपर्क",
    "nav.tasks": "कार्य",
    "nav.reminders": "अनुस्मारक",
    "nav.calendar": "कैलेंडर",
    "common.settings": "सेटिंग्स",
    "common.help": "सहायता",
    "common.logout": "साइन आउट",
    "common.download": "ऐप डाउनलोड करें",
    "common.checkUpdates": "अपडेट जांचें",
    "common.updateAvailable": "अपडेट उपलब्ध",
    "common.close": "बंद करें",
    "group.workspace": "कार्यस्थान",
    "group.operations": "संचालन",
    "settings.title": "सेटिंग्स",
    "settings.notif": "सूचनाएं",
    "settings.accessibility": "सुगम्यता",
    "settings.region": "भाषा और क्षेत्र",
    "settings.security": "सुरक्षा",
    "settings.activity": "गतिविधि लॉग",
    "settings.devices": "डिवाइस",
    "settings.privacy": "गोपनीयता",
    "settings.safety": "संरक्षा",
    "settings.mobile": "मोबाइल ऐप",
    "settings.developer": "डेवलपर विकल्प",
    "settings.profile": "प्रोफ़ाइल",
    "settings.appearance": "दिखावट",
    "region.title": "भाषा और क्षेत्र",
    "region.language": "भाषा",
    "region.timezone": "समय क्षेत्र",
    "region.dateFormat": "दिनांक प्रारूप",
    "region.timeFormat": "समय प्रारूप",
  },
  zh: {
    "nav.dashboard": "仪表板",
    "nav.activity": "动态",
    "nav.search": "搜索",
    "nav.chats": "消息",
    "nav.agents": "智能体",
    "nav.files": "文件",
    "nav.meetings": "会议",
    "nav.calls": "通话",
    "nav.contacts": "联系人",
    "nav.tasks": "任务",
    "nav.reminders": "提醒",
    "nav.calendar": "日历",
    "common.settings": "设置",
    "common.help": "帮助",
    "common.logout": "退出登录",
    "common.download": "下载应用",
    "common.checkUpdates": "检查更新",
    "common.updateAvailable": "有可用更新",
    "common.close": "关闭",
    "group.workspace": "工作区",
    "group.operations": "运营",
    "settings.title": "设置",
    "settings.notif": "通知",
    "settings.accessibility": "无障碍",
    "settings.region": "语言和地区",
    "settings.security": "安全",
    "settings.activity": "活动日志",
    "settings.devices": "设备",
    "settings.privacy": "隐私",
    "settings.safety": "安全防护",
    "settings.mobile": "移动应用",
    "settings.developer": "开发者选项",
    "settings.profile": "个人资料",
    "settings.appearance": "外观",
    "region.title": "语言和地区",
    "region.language": "语言",
    "region.timezone": "时区",
    "region.dateFormat": "日期格式",
    "region.timeFormat": "时间格式",
  },
  ja: {
    "nav.dashboard": "ダッシュボード",
    "nav.activity": "アクティビティ",
    "nav.search": "検索",
    "nav.chats": "メッセージ",
    "nav.agents": "エージェント",
    "nav.files": "ファイル",
    "nav.meetings": "会議",
    "nav.calls": "通話",
    "nav.contacts": "連絡先",
    "nav.tasks": "タスク",
    "nav.reminders": "リマインダー",
    "nav.calendar": "カレンダー",
    "common.settings": "設定",
    "common.help": "ヘルプ",
    "common.logout": "サインアウト",
    "common.download": "アプリをダウンロード",
    "common.checkUpdates": "アップデートを確認",
    "common.updateAvailable": "アップデートがあります",
    "common.close": "閉じる",
    "group.workspace": "ワークスペース",
    "group.operations": "オペレーション",
    "settings.title": "設定",
    "settings.notif": "通知",
    "settings.accessibility": "アクセシビリティ",
    "settings.region": "言語と地域",
    "settings.security": "セキュリティ",
    "settings.activity": "アクティビティログ",
    "settings.devices": "デバイス",
    "settings.privacy": "プライバシー",
    "settings.safety": "セーフティ",
    "settings.mobile": "モバイルアプリ",
    "settings.developer": "開発者向けオプション",
    "settings.profile": "プロフィール",
    "settings.appearance": "外観",
    "region.title": "言語と地域",
    "region.language": "言語",
    "region.timezone": "タイムゾーン",
    "region.dateFormat": "日付形式",
    "region.timeFormat": "時刻形式",
  },
  ru: {
    "nav.dashboard": "Панель",
    "nav.activity": "Активность",
    "nav.search": "Поиск",
    "nav.chats": "Сообщения",
    "nav.agents": "Агенты",
    "nav.files": "Файлы",
    "nav.meetings": "Встречи",
    "nav.calls": "Звонки",
    "nav.contacts": "Контакты",
    "nav.tasks": "Задачи",
    "nav.reminders": "Напоминания",
    "nav.calendar": "Календарь",
    "common.settings": "Настройки",
    "common.help": "Помощь",
    "common.logout": "Выйти",
    "common.download": "Скачать приложение",
    "common.checkUpdates": "Проверить обновления",
    "common.updateAvailable": "Доступно обновление",
    "common.close": "Закрыть",
    "group.workspace": "Рабочая область",
    "group.operations": "Операции",
    "settings.title": "Настройки",
    "settings.notif": "Уведомления",
    "settings.accessibility": "Доступность",
    "settings.region": "Язык и регион",
    "settings.security": "Безопасность",
    "settings.activity": "Журнал активности",
    "settings.devices": "Устройства",
    "settings.privacy": "Конфиденциальность",
    "settings.safety": "Защита",
    "settings.mobile": "Мобильное приложение",
    "settings.developer": "Параметры разработчика",
    "settings.profile": "Профиль",
    "settings.appearance": "Внешний вид",
    "region.title": "Язык и регион",
    "region.language": "Язык",
    "region.timezone": "Часовой пояс",
    "region.dateFormat": "Формат даты",
    "region.timeFormat": "Формат времени",
  },
  ko: {
    "nav.dashboard": "대시보드",
    "nav.activity": "활동",
    "nav.search": "검색",
    "nav.chats": "메시지",
    "nav.agents": "에이전트",
    "nav.files": "파일",
    "nav.meetings": "회의",
    "nav.calls": "통화",
    "nav.contacts": "연락처",
    "nav.tasks": "작업",
    "nav.reminders": "알림",
    "nav.calendar": "캘린더",
    "common.settings": "설정",
    "common.help": "도움말",
    "common.logout": "로그아웃",
    "common.download": "앱 다운로드",
    "common.checkUpdates": "업데이트 확인",
    "common.updateAvailable": "업데이트 사용 가능",
    "common.close": "닫기",
    "group.workspace": "작업 공간",
    "group.operations": "운영",
    "settings.title": "설정",
    "settings.notif": "알림",
    "settings.accessibility": "접근성",
    "settings.region": "언어 및 지역",
    "settings.security": "보안",
    "settings.activity": "활동 로그",
    "settings.devices": "기기",
    "settings.privacy": "개인정보",
    "settings.safety": "안전",
    "settings.mobile": "모바일 앱",
    "settings.developer": "개발자 옵션",
    "settings.profile": "프로필",
    "settings.appearance": "화면 표시",
    "region.title": "언어 및 지역",
    "region.language": "언어",
    "region.timezone": "시간대",
    "region.dateFormat": "날짜 형식",
    "region.timeFormat": "시간 형식",
  },
};

let _lang = "en";
const subs = new Set<() => void>();

export function getLang(): string {
  return _lang;
}

// Set the active language. Unknown/empty falls back to English. Notifies subscribers
// so every mounted useT() component re-renders in the new language.
export function setLang(lang: string | null | undefined): void {
  const next = lang && CATALOGS[lang] ? lang : "en";
  if (next === _lang) return;
  _lang = next;
  // Stamp the document so the browser + CSS pick up language and direction
  // (RTL for Arabic etc.). Guarded for SSR / non-browser.
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = next;
    document.documentElement.dir = dirFor(next);
  }
  subs.forEach((f) => {
    try {
      f();
    } catch {
      /* ignore a bad subscriber */
    }
  });
}

// Replace {name} placeholders from a vars object (leaves an unknown placeholder as-is).
function interpolate(s: string, vars: Record<string, unknown>): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// Translate a key for the active language, falling back to English, then to the
// provided fallback (the original English literal), then the key itself.
// Overloads:
//   t("key")                      → lookup
//   t("key", "English fallback")  → lookup w/ fallback (back-compat)
//   t("key", { name }, "fallback")→ lookup + {name} interpolation
export function t(
  key: string,
  a?: string | Record<string, unknown>,
  b?: string,
): string {
  const vars = a && typeof a === "object" ? a : undefined;
  const fallback = typeof a === "string" ? a : b;
  const raw =
    (CATALOGS[_lang] && CATALOGS[_lang][key]) ||
    (CATALOGS.en && CATALOGS.en[key]) ||
    fallback ||
    key;
  return vars ? interpolate(raw, vars) : raw;
}

// Pluralization: resolves `${key}.<category>` where category is the active
// language's Intl plural rule (zero/one/two/few/many/other) — falling back to
// `.other`/`.one`, then the English catalog. Always interpolates {count}.
export function tp(
  key: string,
  count: number,
  vars?: Record<string, unknown>,
  fallback?: string,
): string {
  let cat = "other";
  try {
    cat = new Intl.PluralRules(_lang).select(count);
  } catch {
    cat = count === 1 ? "one" : "other";
  }
  const look = (k: string) =>
    (CATALOGS[_lang] && CATALOGS[_lang][k]) || (CATALOGS.en && CATALOGS.en[k]);
  const raw = look(`${key}.${cat}`) || look(`${key}.other`) || look(`${key}.one`) || fallback || key;
  return interpolate(raw, { count, ...(vars || {}) });
}

// Locale-aware number / date formatting for the active language.
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(_lang, opts).format(n);
  } catch {
    return String(n);
  }
}
export function fmtDate(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  const date = d instanceof Date ? d : new Date(d);
  try {
    return new Intl.DateTimeFormat(_lang, opts).format(date);
  } catch {
    return String(d);
  }
}

// Reactive translator hook: returns t and re-renders the caller when the language
// changes. No provider needed — subscribes to the module-level pub/sub.
export function useT(): typeof t {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const f = () => force();
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  return t;
}
