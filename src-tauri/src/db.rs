use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn migrate_categories(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(categories)")?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();

    if !columns.iter().any(|c| c == "parent_id") {
        conn.execute("ALTER TABLE categories ADD COLUMN parent_id TEXT", ())?;
    }

    Ok(())
}

pub fn init_db(db_path: PathBuf) -> Result<Connection> {
    let conn = Connection::open(db_path)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY(parent_id) REFERENCES categories(id)
        )",
        (),
    )?;

    migrate_categories(&conn)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            is_dir BOOLEAN NOT NULL,
            screenshot_path TEXT,
            category_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(category_id) REFERENCES categories(id)
        )",
        (),
    )?;

    Ok(conn)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
}

pub fn get_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort_order FROM categories ORDER BY sort_order ASC, name ASC",
    )?;
    let iter = stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            sort_order: row.get(3)?,
        })
    })?;

    let mut categories = Vec::new();
    for c in iter {
        categories.push(c?);
    }
    Ok(categories)
}

pub fn add_category(conn: &Connection, category: &Category) -> Result<()> {
    conn.execute(
        "INSERT INTO categories (id, name, parent_id, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![
            category.id,
            category.name,
            category.parent_id,
            category.sort_order
        ],
    )?;
    Ok(())
}

pub fn update_category(conn: &Connection, category: &Category) -> Result<()> {
    if category.parent_id.as_deref() == Some(category.id.as_str()) {
        return Err(rusqlite::Error::InvalidParameterName(
            "category cannot be its own parent".into(),
        ));
    }

    conn.execute(
        "UPDATE categories SET name = ?1, parent_id = ?2, sort_order = ?3 WHERE id = ?4",
        params![
            category.name,
            category.parent_id,
            category.sort_order,
            category.id
        ],
    )?;
    Ok(())
}

pub fn delete_category(conn: &Connection, id: &str) -> Result<()> {
    let parent_id: Option<String> = conn.query_row(
        "SELECT parent_id FROM categories WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;

    conn.execute(
        "UPDATE categories SET parent_id = ?1 WHERE parent_id = ?2",
        params![parent_id, id],
    )?;

    conn.execute(
        "UPDATE records SET category_id = NULL WHERE category_id = ?1",
        params![id],
    )?;

    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub screenshot_path: Option<String>,
    pub category_id: Option<String>,
    pub created_at: Option<String>,
}

pub fn add_record(conn: &Connection, record: &Record) -> Result<()> {
    conn.execute(
        "INSERT INTO records (id, name, path, is_dir, screenshot_path, category_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![record.id, record.name, record.path, record.is_dir, record.screenshot_path, record.category_id],
    )?;
    Ok(())
}

pub fn get_records(conn: &Connection) -> Result<Vec<Record>> {
    let mut stmt =
        conn.prepare("SELECT id, name, path, is_dir, screenshot_path, category_id, created_at FROM records ORDER BY created_at DESC")?;
    let record_iter = stmt.query_map([], |row| {
        Ok(Record {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            is_dir: row.get(3)?,
            screenshot_path: row.get(4)?,
            category_id: row.get(5)?,
            created_at: row.get(6).unwrap_or(None),
        })
    })?;

    let mut records = Vec::new();
    for r in record_iter {
        records.push(r?);
    }
    Ok(records)
}

pub fn delete_record(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM records WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_db() {
        let conn = init_db(PathBuf::from(":memory:")).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.contains(&"categories".to_string()));
        assert!(tables.contains(&"records".to_string()));
    }

    #[test]
    fn test_crud_record() {
        let conn = init_db(PathBuf::from(":memory:")).unwrap();
        let r = Record {
            id: "123".to_string(),
            name: "test".to_string(),
            path: "/path/test".to_string(),
            is_dir: false,
            screenshot_path: None,
            category_id: None,
            created_at: None,
        };
        add_record(&conn, &r).unwrap();
        let records = get_records(&conn).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "test");
    }

    #[test]
    fn test_crud_category_tree() {
        let conn = init_db(PathBuf::from(":memory:")).unwrap();

        let root = Category {
            id: "root".to_string(),
            name: "工作".to_string(),
            parent_id: None,
            sort_order: 0,
        };
        let child = Category {
            id: "child".to_string(),
            name: "文档".to_string(),
            parent_id: Some("root".to_string()),
            sort_order: 0,
        };

        add_category(&conn, &root).unwrap();
        add_category(&conn, &child).unwrap();

        let categories = get_categories(&conn).unwrap();
        assert_eq!(categories.len(), 2);

        delete_category(&conn, "root").unwrap();
        let categories = get_categories(&conn).unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "child");
        assert!(categories[0].parent_id.is_none());
    }
}
