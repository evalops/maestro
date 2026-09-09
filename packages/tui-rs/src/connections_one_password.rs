//! Native consent for a single 1Password-backed model capability.
//! This UI never reads a vault or resolves a password.
use super::*;

#[derive(Default)]
struct Consent {
    provider: usize,
    field: usize,
    name: String,
    reference: zeroize::Zeroizing<String>,
    allow: bool,
    error: Option<String>,
}

fn supported_types() -> Vec<ConnectionTypeReport> {
    builtin_connection_types()
        .into_iter()
        .filter(|definition| {
            definition.auth_kind == ConnectionAuthKind::ApiKey
                && definition.capabilities == ["models.invoke"]
                && crate::ai::ProviderRegistry::descriptor(&definition.provider_id)
                    .and_then(|provider| provider.default_base_url)
                    .is_some_and(|url| url.starts_with("https://"))
        })
        .map(|definition| ConnectionTypeReport {
            definition,
            source: "maestro".to_owned(),
        })
        .collect()
}

impl Consent {
    fn args(
        &self,
        types: &[ConnectionTypeReport],
        workspace: Option<&Path>,
        locale: crate::localization::Locale,
    ) -> Result<Args> {
        if !self.allow {
            bail!(
                "{}",
                locale
                    .translate("Choose Allow model use before saving. No access has been granted.")
            );
        }
        if self.name.trim().is_empty() {
            bail!("{}", locale.translate("Give this capability a name."));
        }
        crate::ai::op_secret::validate_reference(&self.reference).map_err(|_| {
            anyhow::anyhow!(
                "{}",
                locale
                    .translate("Paste a valid 1Password secret reference (op://vault/item/field).")
            )
        })?;
        let selected = types
            .get(self.provider)
            .context(locale.translate("Choose a supported provider."))?;
        Ok(Args {
            command: Some("add".to_owned()),
            positionals: vec![selected.definition.id.clone(), self.name.trim().to_owned()],
            from_one_password: Some(self.reference.to_string()),
            // Creating a capability must not silently select it for every task.
            default: false,
            workspace: workspace.map(Path::to_path_buf),
            ..Args::default()
        })
    }

    fn edit(&mut self, key: KeyCode, types: usize) {
        self.error = None;
        match key {
            KeyCode::Tab => self.field = (self.field + 1) % 4,
            KeyCode::BackTab => self.field = (self.field + 3) % 4,
            KeyCode::Up if self.field == 0 => self.provider = (self.provider + types - 1) % types,
            KeyCode::Down if self.field == 0 => self.provider = (self.provider + 1) % types,
            KeyCode::Char(' ') if self.field == 3 => self.allow = !self.allow,
            KeyCode::Char(c) if !c.is_control() && self.field == 1 && self.name.len() < 120 => {
                self.name.push(c);
            }
            KeyCode::Char(c)
                if !c.is_control() && self.field == 2 && self.reference.len() < 2048 =>
            {
                self.reference.push(c);
            }
            KeyCode::Backspace if self.field == 1 => {
                self.name.pop();
            }
            KeyCode::Backspace if self.field == 2 => {
                self.reference.pop();
            }
            _ => {}
        }
        // Changing the selected credential or provider requires fresh consent.
        if self.field != 3 {
            self.allow = false;
        }
    }
}

pub(super) fn run(workspace: Option<&Path>) -> Result<()> {
    let locale = crate::localization::cli_locale();
    let types = supported_types();
    if types.is_empty() {
        bail!(
            "{}",
            locale.translate("No supported native model providers are available.")
        );
    }
    let mut terminal = DashboardTerminal::enter()?;
    let mut state = Consent::default();
    let selected = (|| -> Result<Args> {
        loop {
            let mut review_visible = false;
            terminal.terminal.draw(|frame| {
                review_visible = render(frame, &state, &types, locale);
            })?;
            if !event::poll(Duration::from_millis(250))? {
                continue;
            }
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            if key.code == KeyCode::Esc
                || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
            {
                bail!(
                    "{}",
                    locale.translate("1Password setup cancelled. No access was granted.")
                );
            }
            if !review_visible {
                continue;
            }
            if key.code == KeyCode::Enter && state.field == 3 {
                match state.args(&types, workspace, locale) {
                    Ok(args) => return Ok(args),
                    Err(error) => state.error = Some(error.to_string()),
                }
            } else {
                state.edit(key.code, types.len());
            }
        }
    })();
    terminal.restore()?;
    run_add(&selected?)?;
    Ok(())
}

fn render(
    frame: &mut Frame<'_>,
    state: &Consent,
    types: &[ConnectionTypeReport],
    locale: crate::localization::Locale,
) -> bool {
    let theme = crate::themes::current_ui_theme();
    let area = frame.area();
    frame.buffer_mut().set_style(area, theme.text_style());
    let selected = &types[state.provider].definition;
    let destination = crate::ai::ProviderRegistry::descriptor(&selected.provider_id)
        .and_then(|provider| provider.default_base_url)
        .unwrap_or("");
    let field = |index: usize, text: String| {
        Line::styled(
            text,
            if state.field == index {
                Style::default()
                    .fg(theme.focus)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            },
        )
    };
    // The reference input is masked: a mistakenly pasted password never
    // becomes terminal scrollback or a captured screenshot.
    let reference = if state.reference.is_empty() {
        locale.translate("Paste a secret reference").to_owned()
    } else {
        locale.format(
            "Characters entered: {0}",
            &[(state.reference.chars().count()).to_string()],
        )
    };
    let text = vec![
        Line::from(
            locale
                .translate("Give Deixic Code permission to use one credential for model requests."),
        ),
        Line::from(
            locale.translate(
                "Your password stays out of chat, tool results, and saved task history.",
            ),
        ),
        Line::from(""),
        field(
            0,
            locale.format(
                "Provider: {0}  (↑/↓ to choose)",
                &[localized_connection_type_name(
                    &types[state.provider],
                    locale,
                )],
            ),
        ),
        field(
            1,
            locale.format("Capability name: {0}", std::slice::from_ref(&state.name)),
        ),
        field(
            2,
            locale.format("1Password field: {0}", std::slice::from_ref(&reference)),
        ),
        Line::from(""),
        Line::from(locale.translate(
            "In 1Password, enable Settings > Developer > Integrate with 1Password CLI.",
        )),
        Line::from(
            locale.translate("Choose a credential field and copy its secret reference (op://...)."),
        ),
        Line::from(
            locale.translate("Deixic Code does not browse your vault or import its contents."),
        ),
        Line::from(""),
        Line::from(locale.format(
            "Allowed action: Use {0} models (models.invoke)",
            std::slice::from_ref(&selected.provider_id),
        )),
        Line::from(locale.format("Destination: {0}", &[(destination).to_string()])),
        Line::from(
            locale.translate(
                "The native client reads the credential when you select this connection.",
            ),
        ),
        Line::from(
            locale.translate("1Password may ask you to unlock. Custom endpoints are not allowed."),
        ),
        Line::from(locale.translate(
            "Select it explicitly with MAESTRO_CONNECTION, or set a default in Connections.",
        )),
        Line::from(locale.translate(
            "Remove it in Connections to prevent new uses. Existing clients must be closed.",
        )),
        Line::from(""),
        field(
            3,
            locale.format(
                "[{0}] Allow model use   (Space to choose, Enter to save)",
                &[(if state.allow { "x" } else { " " }).to_string()],
            ),
        ),
        Line::from(state.error.as_deref().unwrap_or(
            locale.translate("Tab / Shift-Tab: move   Esc: cancel without granting access"),
        )),
    ];
    // Use the same wrapping for measurement and rendering. Consent is unavailable
    // if any translated access information or control would be clipped.
    let width = frame.area().width.max(80).saturating_sub(2) as usize;
    let wrapped: Vec<Line<'_>> = text
        .iter()
        .flat_map(|line| crate::wrapping::word_wrap_line(line, width))
        .collect();
    let required_rows = (wrapped.len() + 2).max(28);
    if frame.area().width < 80 || usize::from(frame.area().height) < required_rows {
        frame.render_widget(Paragraph::new(locale.format(
            "Enlarge the terminal to at least 80 columns and {0} rows to review access. Esc cancels without granting access.",
            &[required_rows.to_string()])).wrap(Wrap { trim: false }), frame.area());
        return false;
    }
    frame.render_widget(
        Paragraph::new(wrapped).block(
            Block::default()
                .title(locale.translate(" 1Password · Add capability "))
                .borders(Borders::ALL),
        ),
        frame.area(),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn localized_review_preserves_destinations_and_never_clips_consent() {
        for locale in crate::localization::Locale::ALL {
            let types = supported_types();
            let state = Consent {
                name: "my-connection".into(),
                reference: zeroize::Zeroizing::new("do-not-display-this".into()),
                ..Consent::default()
            };
            let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(120, 55)).unwrap();
            terminal
                .draw(|frame| assert!(render(frame, &state, &types, locale)))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let text = buffer
                .content
                .chunks(buffer.area.width as usize)
                .map(|row| {
                    let mut text = String::new();
                    let mut column = 0;
                    while column < row.len() {
                        let symbol = row[column].symbol();
                        text.push_str(symbol);
                        column += unicode_width::UnicodeWidthStr::width(symbol).max(1);
                    }
                    text
                })
                .collect::<String>();
            assert!(text.contains("models.invoke"), "{}", locale.code());
            assert!(text.contains("https://"), "{}", locale.code());
            assert!(text.contains("MAESTRO_CONNECTION"), "{}", locale.code());
            assert!(
                text.contains(&locale.format("Capability name: {0}", &["my-connection".into()])),
                "{}",
                locale.code()
            );
            assert!(!text.contains("do-not-display-this"));
            let display_name = localized_connection_type_name(&types[state.provider], locale);
            assert!(text.contains(&display_name), "{}", locale.code());
            if locale != crate::localization::Locale::English {
                assert!(!text.contains("Anthropic API key"));
            }
            if locale != crate::localization::Locale::English {
                assert!(!text.contains("Your password stays out"));
                assert!(!text.contains("Allow model use"));
            }
            let mut small = Terminal::new(ratatui::backend::TestBackend::new(80, 20)).unwrap();
            small
                .draw(|frame| assert!(!render(frame, &state, &types, locale)))
                .unwrap();
        }
    }

    #[test]
    fn consent_is_required_and_never_sets_a_default() {
        let types = supported_types();
        assert!(!types.is_empty());
        let mut state = Consent {
            name: "work".into(),
            reference: zeroize::Zeroizing::new("op://vault/item/credential".into()),
            ..Consent::default()
        };
        assert!(
            state
                .args(&types, None, crate::localization::Locale::English)
                .is_err()
        );
        state.allow = true;
        assert!(
            !state
                .args(&types, None, crate::localization::Locale::English)
                .unwrap()
                .default
        );
        state.field = 0;
        state.edit(KeyCode::Down, types.len());
        assert!(!state.allow);
    }

    #[test]
    fn render_never_displays_the_pasted_value() {
        let types = supported_types();
        let backend = ratatui::backend::TestBackend::new(100, 28);
        let mut terminal = Terminal::new(backend).unwrap();
        let state = Consent {
            reference: zeroize::Zeroizing::new("accidentally-pasted-password".into()),
            ..Consent::default()
        };
        terminal
            .draw(|frame| {
                render(frame, &state, &types, crate::localization::Locale::English);
            })
            .unwrap();
        let display = format!("{:?}", terminal.backend().buffer());
        assert!(!display.contains("accidentally-pasted-password"));
        assert!(
            state
                .args(&types, None, crate::localization::Locale::English)
                .is_err()
        );
    }
}
