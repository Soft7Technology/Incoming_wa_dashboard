export interface CampaignContactFilters {
  search?: string;
  country_code?: string[];
  tag_ids?: string[];
  list_ids?: string[];
  status?: string;
  is_valid?: boolean;
  attributes?: Record<string, string | number | boolean>;
  onlyAssignedToUserId?: string;
}

export interface CampaignContactSelection {
  phoneNumberId: string;
  filters: CampaignContactFilters;
  sortBy: 'created_at' | 'updated_at' | 'name' | 'phone_number';
  sortOrder: 'asc' | 'desc';
}
