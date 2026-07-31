use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

pub fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::menu::Menu<R>, tauri::Error> {
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu])
        .build()?;

    Ok(menu)
}
