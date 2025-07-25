CREATE TABLE IF NOT EXISTS fastsite (
    id INTEGER PRIMARY KEY, -- ID
    visit_url TEXT NOT NULL, -- 访问地址
    target_url TEXT NOT NULL, -- 目标地址
    description TEXT DEFAULT '' NULL -- 描述
);