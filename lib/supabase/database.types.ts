export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string;
          actor_type: string;
          actor_user_id: string | null;
          after: Json | null;
          before: Json | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string;
          id: string;
          ip_address: string | null;
          tenant_id: string | null;
          user_agent: string | null;
        };
        Insert: {
          action: string;
          actor_type: string;
          actor_user_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type: string;
          id?: string;
          ip_address?: string | null;
          tenant_id?: string | null;
          user_agent?: string | null;
        };
        Update: {
          action?: string;
          actor_type?: string;
          actor_user_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string;
          id?: string;
          ip_address?: string | null;
          tenant_id?: string | null;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      branches: {
        Row: {
          address: string | null;
          created_at: string;
          deleted_at: string | null;
          id: string;
          is_primary: boolean;
          name: string;
          phone: string | null;
          tenant_id: string;
          updated_at: string;
        };
        Insert: {
          address?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          is_primary?: boolean;
          name: string;
          phone?: string | null;
          tenant_id: string;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          is_primary?: boolean;
          name?: string;
          phone?: string | null;
          tenant_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "branches_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      features: {
        Row: {
          category: string | null;
          created_at: string;
          description: string | null;
          id: string;
          key: string;
          name: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          key: string;
          name: string;
        };
        Update: {
          category?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          key?: string;
          name?: string;
        };
        Relationships: [];
      };
      permissions: {
        Row: {
          category: string;
          created_at: string;
          description: string | null;
          id: string;
          key: string;
          name: string;
        };
        Insert: {
          category: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          key: string;
          name: string;
        };
        Update: {
          category?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          key?: string;
          name?: string;
        };
        Relationships: [];
      };
      plan_features: {
        Row: {
          config: Json | null;
          feature_id: string;
          limit_value: number | null;
          plan_id: string;
        };
        Insert: {
          config?: Json | null;
          feature_id: string;
          limit_value?: number | null;
          plan_id: string;
        };
        Update: {
          config?: Json | null;
          feature_id?: string;
          limit_value?: number | null;
          plan_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "plan_features_feature_id_fkey";
            columns: ["feature_id"];
            isOneToOne: false;
            referencedRelation: "features";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "plan_features_plan_id_fkey";
            columns: ["plan_id"];
            isOneToOne: false;
            referencedRelation: "plans";
            referencedColumns: ["id"];
          },
        ];
      };
      plans: {
        Row: {
          created_at: string;
          currency: string;
          description: string | null;
          id: string;
          is_active: boolean;
          key: string;
          name: string;
          price_monthly: number | null;
          price_yearly: number | null;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          currency?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          key: string;
          name: string;
          price_monthly?: number | null;
          price_yearly?: number | null;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          currency?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          key?: string;
          name?: string;
          price_monthly?: number | null;
          price_yearly?: number | null;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      platform_admins: {
        Row: {
          created_at: string;
          granted_by: string | null;
          id: string;
          is_active: boolean;
          role: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          is_active?: boolean;
          role?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          is_active?: boolean;
          role?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          full_name: string | null;
          id: string;
          phone: string | null;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id: string;
          phone?: string | null;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id?: string;
          phone?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      role_permissions: {
        Row: {
          permission_id: string;
          role_id: string;
        };
        Insert: {
          permission_id: string;
          role_id: string;
        };
        Update: {
          permission_id?: string;
          role_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey";
            columns: ["permission_id"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
        ];
      };
      role_template_permissions: {
        Row: {
          permission_id: string;
          role_template_id: string;
        };
        Insert: {
          permission_id: string;
          role_template_id: string;
        };
        Update: {
          permission_id?: string;
          role_template_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "role_template_permissions_permission_id_fkey";
            columns: ["permission_id"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "role_template_permissions_role_template_id_fkey";
            columns: ["role_template_id"];
            isOneToOne: false;
            referencedRelation: "role_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      role_templates: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          key: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          key: string;
          name: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          key?: string;
          name?: string;
        };
        Relationships: [];
      };
      roles: {
        Row: {
          cloned_from_template_id: string | null;
          created_at: string;
          deleted_at: string | null;
          description: string | null;
          id: string;
          is_system_default: boolean;
          key: string | null;
          name: string;
          tenant_id: string;
          updated_at: string;
        };
        Insert: {
          cloned_from_template_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          is_system_default?: boolean;
          key?: string | null;
          name: string;
          tenant_id: string;
          updated_at?: string;
        };
        Update: {
          cloned_from_template_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          is_system_default?: boolean;
          key?: string | null;
          name?: string;
          tenant_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "roles_cloned_from_template_id_fkey";
            columns: ["cloned_from_template_id"];
            isOneToOne: false;
            referencedRelation: "role_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "roles_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          canceled_at: string | null;
          created_at: string;
          current_period_end: string | null;
          current_period_start: string | null;
          id: string;
          plan_id: string;
          provider: string | null;
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          status: string;
          tenant_id: string;
          trial_ends_at: string | null;
          updated_at: string;
        };
        Insert: {
          canceled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          current_period_start?: string | null;
          id?: string;
          plan_id: string;
          provider?: string | null;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          status?: string;
          tenant_id: string;
          trial_ends_at?: string | null;
          updated_at?: string;
        };
        Update: {
          canceled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          current_period_start?: string | null;
          id?: string;
          plan_id?: string;
          provider?: string | null;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          status?: string;
          tenant_id?: string;
          trial_ends_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey";
            columns: ["plan_id"];
            isOneToOne: false;
            referencedRelation: "plans";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: true;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      tenant_features: {
        Row: {
          created_at: string;
          enabled: boolean;
          feature_id: string;
          granted_by: string | null;
          id: string;
          note: string | null;
          tenant_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          enabled: boolean;
          feature_id: string;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          tenant_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          feature_id?: string;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          tenant_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tenant_features_feature_id_fkey";
            columns: ["feature_id"];
            isOneToOne: false;
            referencedRelation: "features";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tenant_features_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      tenant_memberships: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          id: string;
          invited_by: string | null;
          role_id: string;
          status: string;
          tenant_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          invited_by?: string | null;
          role_id: string;
          status?: string;
          tenant_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          invited_by?: string | null;
          role_id?: string;
          status?: string;
          tenant_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      tenants: {
        Row: {
          created_at: string;
          created_by: string | null;
          currency: string;
          deleted_at: string | null;
          id: string;
          name: string;
          slug: string;
          status: string;
          timezone: string;
          trial_ends_at: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          deleted_at?: string | null;
          id?: string;
          name: string;
          slug: string;
          status?: string;
          timezone?: string;
          trial_ends_at?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          deleted_at?: string | null;
          id?: string;
          name?: string;
          slug?: string;
          status?: string;
          timezone?: string;
          trial_ends_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_tenant: {
        Args: { p_name: string; p_slug: string };
        Returns: string;
      };
      has_feature: {
        Args: { p_feature_key: string; p_tenant_id: string };
        Returns: boolean;
      };
      has_permission: {
        Args: { p_permission_key: string; p_tenant_id: string };
        Returns: boolean;
      };
      is_platform_admin: { Args: never; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
