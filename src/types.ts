export interface RecordItem {
  id: string;
  name: string;
  path: string;
  is_dir: boolean;
  screenshot_path?: string;
  category_id?: string;
  created_at?: string;
}

export interface CategoryItem {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

export type CategoryFilter = 'all' | string;

export interface CategoryTreeNode extends CategoryItem {
  children: CategoryTreeNode[];
}
