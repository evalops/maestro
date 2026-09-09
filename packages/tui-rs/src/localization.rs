//! Display-only translations. Command names, model prompts, and protocol values stay unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Locale {
    #[default]
    English,
    Spanish,
    French,
    German,
    Japanese,
    Korean,
    Chinese,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKey {
    McpServers,
    Search,
    NoMatches,
    Configured,
    Available,
    NoServers,
    NoTools,
    CatalogHelp,
    ManagerHelp,
    Copied,
    CopyFailed,
    Language,
    LanguageHelp,
    Settings,
    Appearance,
    SaveFailed,
}
impl Locale {
    pub const ALL: [Self; 7] = [
        Self::English,
        Self::Spanish,
        Self::French,
        Self::German,
        Self::Japanese,
        Self::Korean,
        Self::Chinese,
    ];
    pub fn code(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Spanish => "es",
            Self::French => "fr",
            Self::German => "de",
            Self::Japanese => "ja",
            Self::Korean => "ko",
            Self::Chinese => "zh-CN",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::English => "English",
            Self::Spanish => "Español",
            Self::French => "Français",
            Self::German => "Deutsch",
            Self::Japanese => "日本語",
            Self::Korean => "한국어",
            Self::Chinese => "简体中文",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        let normalized = value.trim().replace('_', "-").to_ascii_lowercase();
        match normalized.as_str() {
            "en" | "en-us" | "en-gb" => Some(Self::English),
            "es" | "es-es" | "es-mx" => Some(Self::Spanish),
            "fr" | "fr-fr" | "fr-ca" => Some(Self::French),
            "de" | "de-de" => Some(Self::German),
            "ja" | "ja-jp" => Some(Self::Japanese),
            "ko" | "ko-kr" => Some(Self::Korean),
            "zh-cn" | "zh-hans" | "zh-sg" => Some(Self::Chinese),
            _ => None,
        }
    }
    pub fn text(self, key: TextKey) -> &'static str {
        translated(self, key)
            .or_else(|| translated(Self::English, key))
            .expect("English covers every display key")
    }
}
fn translated(locale: Locale, key: TextKey) -> Option<&'static str> {
    let catalog: &[(TextKey, &str)] = match locale {
        Locale::English => &[
            (TextKey::McpServers, "MCP servers"),
            (TextKey::Search, "Search"),
            (TextKey::NoMatches, "No matching connections."),
            (TextKey::Configured, "Configured"),
            (TextKey::Available, "Available"),
            (
                TextKey::NoServers,
                "No MCP servers configured. Press c to browse connections.",
            ),
            (TextKey::NoTools, "No tools reported."),
            (
                TextKey::CatalogHelp,
                "Type to search · ↑/↓ select · Enter add · Esc back",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ select · Enter tools · Space toggle · r retry · a custom · c browse · o sign in · x sign out · d remove · Esc close",
            ),
            (TextKey::Copied, "Copied to clipboard"),
            (TextKey::CopyFailed, "Could not copy"),
            (TextKey::Language, "Display language"),
            (
                TextKey::LanguageHelp,
                "Choose a language for supported interface text. Other text uses English.",
            ),
            (TextKey::Settings, "Settings"),
            (TextKey::Appearance, "Appearance and keyboard"),
            (TextKey::SaveFailed, "Could not save display language"),
        ],
        Locale::Spanish => &[
            (TextKey::McpServers, "Servidores MCP"),
            (TextKey::Search, "Buscar"),
            (TextKey::NoMatches, "No hay conexiones coincidentes."),
            (TextKey::Configured, "Configurado"),
            (TextKey::Available, "Disponible"),
            (
                TextKey::NoServers,
                "No hay servidores MCP. Pulsa c para buscar conexiones.",
            ),
            (TextKey::NoTools, "No se han informado herramientas."),
            (
                TextKey::CatalogHelp,
                "Escribe para buscar · ↑/↓ elegir · Enter añadir · Esc volver",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ elegir · Enter herramientas · Espacio activar · r reintentar · a personalizado · c buscar · o iniciar sesión · x cerrar sesión · d eliminar · Esc cerrar",
            ),
            (TextKey::Copied, "Copiado al portapapeles"),
            (TextKey::CopyFailed, "No se pudo copiar"),
            (TextKey::Language, "Idioma de la interfaz"),
            (
                TextKey::LanguageHelp,
                "Elige el idioma de los textos compatibles. Los demás usan inglés.",
            ),
            (TextKey::Settings, "Ajustes"),
            (TextKey::Appearance, "Apariencia y teclado"),
            (TextKey::SaveFailed, "No se pudo guardar el idioma"),
        ],
        Locale::French => &[
            (TextKey::McpServers, "Serveurs MCP"),
            (TextKey::Search, "Rechercher"),
            (TextKey::NoMatches, "Aucune connexion correspondante."),
            (TextKey::Configured, "Configuré"),
            (TextKey::Available, "Disponible"),
            (
                TextKey::NoServers,
                "Aucun serveur MCP. Appuyez sur c pour parcourir les connexions.",
            ),
            (TextKey::NoTools, "Aucun outil signalé."),
            (
                TextKey::CatalogHelp,
                "Saisir pour rechercher · ↑/↓ choisir · Enter ajouter · Esc retour",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ choisir · Enter outils · Espace activer · r réessayer · a personnalisé · c parcourir · o connexion · x déconnexion · d supprimer · Esc fermer",
            ),
            (TextKey::Copied, "Copié dans le presse-papiers"),
            (TextKey::CopyFailed, "Impossible de copier"),
            (TextKey::Language, "Langue d’affichage"),
            (
                TextKey::LanguageHelp,
                "Choisissez la langue des textes traduits. Les autres restent en anglais.",
            ),
            (TextKey::Settings, "Paramètres"),
            (TextKey::Appearance, "Apparence et clavier"),
            (TextKey::SaveFailed, "Impossible d’enregistrer la langue"),
        ],
        Locale::German => &[
            (TextKey::McpServers, "MCP-Server"),
            (TextKey::Search, "Suchen"),
            (TextKey::NoMatches, "Keine passenden Verbindungen."),
            (TextKey::Configured, "Konfiguriert"),
            (TextKey::Available, "Verfügbar"),
            (
                TextKey::NoServers,
                "Keine MCP-Server. Mit c Verbindungen durchsuchen.",
            ),
            (TextKey::NoTools, "Keine Tools gemeldet."),
            (
                TextKey::CatalogHelp,
                "Tippen zum Suchen · ↑/↓ wählen · Enter hinzufügen · Esc zurück",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ wählen · Enter Tools · Leertaste umschalten · r erneut · a eigene · c suchen · o anmelden · x abmelden · d entfernen · Esc schließen",
            ),
            (TextKey::Copied, "In die Zwischenablage kopiert"),
            (TextKey::CopyFailed, "Kopieren fehlgeschlagen"),
            (TextKey::Language, "Anzeigesprache"),
            (
                TextKey::LanguageHelp,
                "Sprache für übersetzte Oberflächentexte wählen. Andere Texte bleiben Englisch.",
            ),
            (TextKey::Settings, "Einstellungen"),
            (TextKey::Appearance, "Darstellung und Tastatur"),
            (
                TextKey::SaveFailed,
                "Anzeigesprache konnte nicht gespeichert werden",
            ),
        ],
        Locale::Japanese => &[
            (TextKey::McpServers, "MCP サーバー"),
            (TextKey::Search, "検索"),
            (TextKey::NoMatches, "一致する接続はありません。"),
            (TextKey::Configured, "設定済み"),
            (TextKey::Available, "利用可能"),
            (
                TextKey::NoServers,
                "MCP サーバーは未設定です。c で接続を探せます。",
            ),
            (TextKey::NoTools, "ツールはありません。"),
            (
                TextKey::CatalogHelp,
                "入力で検索 · ↑/↓ 選択 · Enter 追加 · Esc 戻る",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ 選択 · Enter ツール · Space 切替 · r 再試行 · a 手動追加 · c 検索 · o ログイン · x ログアウト · d 削除 · Esc 閉じる",
            ),
            (TextKey::Copied, "クリップボードにコピーしました"),
            (TextKey::CopyFailed, "コピーできませんでした"),
            (TextKey::Language, "表示言語"),
            (
                TextKey::LanguageHelp,
                "対応する画面テキストの言語を選択します。未翻訳のテキストは英語で表示されます。",
            ),
            (TextKey::Settings, "設定"),
            (TextKey::Appearance, "外観とキーボード"),
            (TextKey::SaveFailed, "表示言語を保存できませんでした"),
        ],
        Locale::Korean => &[
            (TextKey::McpServers, "MCP 서버"),
            (TextKey::Search, "검색"),
            (TextKey::NoMatches, "일치하는 연결이 없습니다."),
            (TextKey::Configured, "구성됨"),
            (TextKey::Available, "사용 가능"),
            (
                TextKey::NoServers,
                "MCP 서버가 없습니다. c를 눌러 연결을 찾아보세요.",
            ),
            (TextKey::NoTools, "보고된 도구가 없습니다."),
            (
                TextKey::CatalogHelp,
                "입력하여 검색 · ↑/↓ 선택 · Enter 추가 · Esc 뒤로",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ 선택 · Enter 도구 · Space 전환 · r 재시도 · a 직접 추가 · c 찾기 · o 로그인 · x 로그아웃 · d 제거 · Esc 닫기",
            ),
            (TextKey::Copied, "클립보드에 복사했습니다"),
            (TextKey::CopyFailed, "복사하지 못했습니다"),
            (TextKey::Language, "표시 언어"),
            (
                TextKey::LanguageHelp,
                "지원되는 화면 텍스트의 언어를 선택하세요. 나머지는 영어로 표시됩니다.",
            ),
            (TextKey::Settings, "설정"),
            (TextKey::Appearance, "모양 및 키보드"),
            (TextKey::SaveFailed, "표시 언어를 저장하지 못했습니다"),
        ],
        Locale::Chinese => &[
            (TextKey::McpServers, "MCP 服务器"),
            (TextKey::Search, "搜索"),
            (TextKey::NoMatches, "没有匹配的连接。"),
            (TextKey::Configured, "已配置"),
            (TextKey::Available, "可用"),
            (TextKey::NoServers, "尚未配置 MCP 服务器。按 c 浏览连接。"),
            (TextKey::NoTools, "没有可用工具。"),
            (
                TextKey::CatalogHelp,
                "输入搜索 · ↑/↓ 选择 · Enter 添加 · Esc 返回",
            ),
            (
                TextKey::ManagerHelp,
                "↑/↓ 选择 · Enter 工具 · Space 切换 · r 重试 · a 自定义 · c 浏览 · o 登录 · x 退出登录 · d 移除 · Esc 关闭",
            ),
            (TextKey::Copied, "已复制到剪贴板"),
            (TextKey::CopyFailed, "无法复制"),
            (TextKey::Language, "显示语言"),
            (
                TextKey::LanguageHelp,
                "选择已翻译界面的语言。其他文本将使用英语。",
            ),
            (TextKey::Settings, "设置"),
            (TextKey::Appearance, "外观与键盘"),
            (TextKey::SaveFailed, "无法保存显示语言"),
        ],
    };
    catalog
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, text)| *text)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_display_keys_have_nonempty_translations() {
        for locale in Locale::ALL {
            for key in [
                TextKey::McpServers,
                TextKey::Search,
                TextKey::NoMatches,
                TextKey::Configured,
                TextKey::Available,
                TextKey::NoServers,
                TextKey::NoTools,
                TextKey::CatalogHelp,
                TextKey::ManagerHelp,
                TextKey::Copied,
                TextKey::CopyFailed,
                TextKey::Language,
                TextKey::LanguageHelp,
                TextKey::Settings,
                TextKey::Appearance,
                TextKey::SaveFailed,
            ] {
                assert!(!locale.text(key).trim().is_empty());
            }
            assert_eq!(Locale::parse(locale.code()), Some(locale));
        }
    }
    #[test]
    fn locale_aliases_are_explicit_and_unknown_locales_are_rejected() {
        assert_eq!(Locale::parse("ja_JP"), Some(Locale::Japanese));
        assert_eq!(Locale::parse("zh-Hans"), Some(Locale::Chinese));
        assert_eq!(Locale::parse("zh-TW"), None);
        assert_eq!(Locale::parse("unknown"), None);
    }
}
