export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      appointment_items: {
        Row: {
          appointment_id: string
          appointment_status: string
          created_at: string
          duration_minutes: number
          id: string
          price: number
          scheduled_end_at: string
          scheduled_start_at: string
          sequence: number
          service_id: string
          staff_member_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          appointment_id: string
          appointment_status?: string
          created_at?: string
          duration_minutes: number
          id?: string
          price: number
          scheduled_end_at: string
          scheduled_start_at: string
          sequence: number
          service_id: string
          staff_member_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          appointment_id?: string
          appointment_status?: string
          created_at?: string
          duration_minutes?: number
          id?: string
          price?: number
          scheduled_end_at?: string
          scheduled_start_at?: string
          sequence?: number
          service_id?: string
          staff_member_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointment_items_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_items_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          idempotency_fingerprint: string | null
          idempotency_key: string | null
          notes: string | null
          scheduled_end_at: string
          scheduled_start_at: string
          source: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          idempotency_fingerprint?: string | null
          idempotency_key?: string | null
          notes?: string | null
          scheduled_end_at: string
          scheduled_start_at: string
          source?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          idempotency_fingerprint?: string | null
          idempotency_key?: string | null
          notes?: string | null
          scheduled_end_at?: string
          scheduled_start_at?: string
          source?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_type: string
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          ip_address: string | null
          tenant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_type: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          ip_address?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_type?: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip_address?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_account_claims: {
        Row: {
          appointment_id: string
          consumed_at: string | null
          consumed_by_user_id: string | null
          created_at: string
          customer_id: string
          email_normalized_snapshot: string
          email_snapshot: string
          expires_at: string
          id: string
          secret_hash: string
          tenant_id: string
        }
        Insert: {
          appointment_id: string
          consumed_at?: string | null
          consumed_by_user_id?: string | null
          created_at?: string
          customer_id: string
          email_normalized_snapshot: string
          email_snapshot: string
          expires_at: string
          id?: string
          secret_hash: string
          tenant_id: string
        }
        Update: {
          appointment_id?: string
          consumed_at?: string | null
          consumed_by_user_id?: string | null
          created_at?: string
          customer_id?: string
          email_normalized_snapshot?: string
          email_snapshot?: string
          expires_at?: string
          id?: string
          secret_hash?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_account_claims_appointment_tenant_fkey"
            columns: ["appointment_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "booking_account_claims_customer_tenant_fkey"
            columns: ["customer_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "booking_account_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          created_at: string
          deleted_at: string | null
          id: string
          is_primary: boolean
          name: string
          phone: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          name: string
          phone?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_account_links: {
        Row: {
          claimed_via: string
          created_at: string
          customer_id: string
          deleted_at: string | null
          id: string
          is_primary: boolean
          tenant_id: string
          user_id: string
        }
        Insert: {
          claimed_via: string
          created_at?: string
          customer_id: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          tenant_id: string
          user_id: string
        }
        Update: {
          claimed_via?: string
          created_at?: string
          customer_id?: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_account_links_customer_tenant_fkey"
            columns: ["customer_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "customer_account_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_account_pairing_codes: {
        Row: {
          code_hash: string
          consumed_at: string | null
          consumed_by_customer_id: string | null
          created_at: string
          expires_at: string
          id: string
          revoked_at: string | null
          tenant_id: string
          user_id: string
        }
        Insert: {
          code_hash: string
          consumed_at?: string | null
          consumed_by_customer_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          revoked_at?: string | null
          tenant_id: string
          user_id: string
        }
        Update: {
          code_hash?: string
          consumed_at?: string | null
          consumed_by_customer_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          revoked_at?: string | null
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_account_pairing_codes_customer_tenant_fkey"
            columns: ["consumed_by_customer_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "customer_account_pairing_codes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          email: string | null
          email_normalized: string | null
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          phone_normalized: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          email?: string | null
          email_normalized?: string | null
          full_name: string
          id?: string
          notes?: string | null
          phone?: string | null
          phone_normalized?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          email?: string | null
          email_normalized?: string | null
          full_name?: string
          id?: string
          notes?: string | null
          phone?: string | null
          phone_normalized?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      features: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          id: string
          key: string
          name: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          key: string
          name: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          name?: string
        }
        Relationships: []
      }
      permissions: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          key: string
          name: string
        }
        Insert: {
          category: string
          created_at?: string
          description?: string | null
          id?: string
          key: string
          name: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          name?: string
        }
        Relationships: []
      }
      plan_features: {
        Row: {
          config: Json | null
          feature_id: string
          limit_value: number | null
          plan_id: string
        }
        Insert: {
          config?: Json | null
          feature_id: string
          limit_value?: number | null
          plan_id: string
        }
        Update: {
          config?: Json | null
          feature_id?: string
          limit_value?: number | null
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_features_feature_id_fkey"
            columns: ["feature_id"]
            isOneToOne: false
            referencedRelation: "features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_features_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          key: string
          name: string
          price_monthly: number | null
          price_yearly: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key: string
          name: string
          price_monthly?: number | null
          price_yearly?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key?: string
          name?: string
          price_monthly?: number | null
          price_yearly?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          is_active: boolean
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          is_active?: boolean
          role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          is_active?: boolean
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_template_permissions: {
        Row: {
          permission_id: string
          role_template_id: string
        }
        Insert: {
          permission_id: string
          role_template_id: string
        }
        Update: {
          permission_id?: string
          role_template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_template_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_template_permissions_role_template_id_fkey"
            columns: ["role_template_id"]
            isOneToOne: false
            referencedRelation: "role_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      role_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          name?: string
        }
        Relationships: []
      }
      roles: {
        Row: {
          cloned_from_template_id: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          is_system_default: boolean
          key: string | null
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cloned_from_template_id?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_system_default?: boolean
          key?: string | null
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cloned_from_template_id?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_system_default?: boolean
          key?: string | null
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_cloned_from_template_id_fkey"
            columns: ["cloned_from_template_id"]
            isOneToOne: false
            referencedRelation: "role_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_branches: {
        Row: {
          branch_id: string
          created_at: string
          service_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          service_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_branches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_branches_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          display_order: number
          duration_minutes: number
          id: string
          name: string
          price: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          display_order?: number
          duration_minutes: number
          id?: string
          name: string
          price: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          display_order?: number
          duration_minutes?: number
          id?: string
          name?: string
          price?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_branches: {
        Row: {
          branch_id: string
          created_at: string
          staff_member_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          staff_member_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          staff_member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_branches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_branches_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_members: {
        Row: {
          color: string | null
          concurrent_capacity: number
          created_at: string
          created_by: string | null
          deleted_at: string | null
          display_order: number
          email: string | null
          full_name: string
          id: string
          phone: string | null
          status: string
          tenant_id: string
          tenant_membership_id: string | null
          updated_at: string
        }
        Insert: {
          color?: string | null
          concurrent_capacity?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          display_order?: number
          email?: string | null
          full_name: string
          id?: string
          phone?: string | null
          status?: string
          tenant_id: string
          tenant_membership_id?: string | null
          updated_at?: string
        }
        Update: {
          color?: string | null
          concurrent_capacity?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          display_order?: number
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          status?: string
          tenant_id?: string
          tenant_membership_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_members_membership_same_tenant"
            columns: ["tenant_membership_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "staff_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_members_tenant_membership_id_fkey"
            columns: ["tenant_membership_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_schedule_exceptions: {
        Row: {
          created_at: string
          deleted_at: string | null
          end_time: string | null
          exception_date: string
          id: string
          reason: string | null
          staff_member_id: string
          start_time: string | null
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          end_time?: string | null
          exception_date: string
          id?: string
          reason?: string | null
          staff_member_id: string
          start_time?: string | null
          tenant_id: string
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          end_time?: string | null
          exception_date?: string
          id?: string
          reason?: string | null
          staff_member_id?: string
          start_time?: string | null
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_schedule_exceptions_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_schedule_exceptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_schedules: {
        Row: {
          branch_id: string | null
          created_at: string
          deleted_at: string | null
          end_time: string
          id: string
          staff_member_id: string
          start_time: string
          tenant_id: string
          updated_at: string
          weekday: number
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          deleted_at?: string | null
          end_time: string
          id?: string
          staff_member_id: string
          start_time: string
          tenant_id: string
          updated_at?: string
          weekday: number
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          deleted_at?: string | null
          end_time?: string
          id?: string
          staff_member_id?: string
          start_time?: string
          tenant_id?: string
          updated_at?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_schedules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_schedules_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_schedules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_services: {
        Row: {
          created_at: string
          service_id: string
          staff_member_id: string
        }
        Insert: {
          created_at?: string
          service_id: string
          staff_member_id: string
        }
        Update: {
          created_at?: string
          service_id?: string
          staff_member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_services_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan_id: string
          provider: string | null
          provider_customer_id: string | null
          provider_subscription_id: string | null
          status: string
          tenant_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id: string
          provider?: string | null
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          tenant_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id?: string
          provider?: string | null
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          tenant_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_features: {
        Row: {
          created_at: string
          enabled: boolean
          feature_id: string
          granted_by: string | null
          id: string
          note: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled: boolean
          feature_id: string
          granted_by?: string | null
          id?: string
          note?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          feature_id?: string
          granted_by?: string | null
          id?: string
          note?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_features_feature_id_fkey"
            columns: ["feature_id"]
            isOneToOne: false
            referencedRelation: "features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_features_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          invited_by: string | null
          role_id: string
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          invited_by?: string | null
          role_id: string
          status?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          invited_by?: string | null
          role_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          customer_cancellation_cutoff_minutes: number
          customer_cancellation_enabled: boolean
          customer_reschedule_cutoff_minutes: number
          customer_reschedule_enabled: boolean
          deleted_at: string | null
          id: string
          name: string
          slug: string
          status: string
          timezone: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_cancellation_cutoff_minutes?: number
          customer_cancellation_enabled?: boolean
          customer_reschedule_cutoff_minutes?: number
          customer_reschedule_enabled?: boolean
          deleted_at?: string | null
          id?: string
          name: string
          slug: string
          status?: string
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_cancellation_cutoff_minutes?: number
          customer_cancellation_enabled?: boolean
          customer_reschedule_cutoff_minutes?: number
          customer_reschedule_enabled?: boolean
          deleted_at?: string | null
          id?: string
          name?: string
          slug?: string
          status?: string
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_my_appointment: {
        Args: { p_appointment_id: string }
        Returns: Json
      }
      check_appointment_availability: {
        Args: {
          p_branch_id: string
          p_exclude_appointment_id?: string
          p_scheduled_start_at: string
          p_service_id: string
          p_staff_member_id: string
          p_tenant_id: string
        }
        Returns: {
          is_available: boolean
          reason: string
          scheduled_end_at: string
        }[]
      }
      claim_my_recent_booking: {
        Args: { p_claim_ref: string; p_claim_secret_hash: string }
        Returns: Json
      }
      create_appointment: {
        Args: {
          p_branch_id: string
          p_customer_id: string
          p_items: Json
          p_notes?: string
          p_source?: string
          p_tenant_id: string
        }
        Returns: string
      }
      create_guest_booking: {
        Args: {
          p_branch_id: string
          p_claim_secret_hash?: string
          p_customer_account_user_id?: string
          p_customer_email?: string
          p_customer_full_name: string
          p_customer_phone: string
          p_idempotency_key?: string
          p_scheduled_start_at: string
          p_service_id: string
          p_staff_member_id?: string
          p_tenant_slug: string
        }
        Returns: Json
      }
      create_my_link_code: {
        Args: { p_code_hash: string; p_tenant_slug: string }
        Returns: Json
      }
      create_role: {
        Args: {
          p_description: string
          p_name: string
          p_permission_keys: string[]
          p_tenant_id: string
        }
        Returns: string
      }
      create_tenant: {
        Args: { p_name: string; p_slug: string }
        Returns: string
      }
      get_customer_account_link_status: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      get_my_account_profile: { Args: never; Returns: Json }
      get_my_appointments: { Args: never; Returns: Json }
      get_my_link_salon_context: {
        Args: { p_tenant_slug: string }
        Returns: Json
      }
      get_my_reschedule_slots: {
        Args: { p_appointment_id: string; p_date: string }
        Returns: Json
      }
      get_public_availability_slots: {
        Args: {
          p_branch_id: string
          p_date: string
          p_service_id: string
          p_staff_member_id?: string
          p_tenant_slug: string
        }
        Returns: Json
      }
      get_public_booking_context: {
        Args: { p_tenant_slug: string }
        Returns: Json
      }
      get_public_eligible_staff: {
        Args: {
          p_branch_id: string
          p_service_id: string
          p_tenant_slug: string
        }
        Returns: Json
      }
      has_feature: {
        Args: { p_feature_key: string; p_tenant_id: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_permission_key: string; p_tenant_id: string }
        Returns: boolean
      }
      is_platform_admin: { Args: never; Returns: boolean }
      link_customer_account_with_code: {
        Args: { p_code_hash: string; p_customer_id: string }
        Returns: Json
      }
      reschedule_appointment: {
        Args: { p_appointment_id: string; p_items: Json }
        Returns: undefined
      }
      reschedule_my_appointment: {
        Args: { p_appointment_id: string; p_new_start_at: string }
        Returns: Json
      }
      search_customers: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_status?: string
          p_tenant_id: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          email: string | null
          email_normalized: string | null
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          phone_normalized: string | null
          status: string
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "customers"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      security_audit_column_grants: {
        Args: never
        Returns: {
          column_name: string
          grantee: string
          privilege_type: string
          schema_name: string
          table_name: string
        }[]
      }
      security_audit_default_privileges: {
        Args: never
        Returns: {
          for_role: string
          grantee: string
          object_type: string
          privilege_type: string
          schema_name: string
        }[]
      }
      security_audit_extension_function_grants: {
        Args: never
        Returns: {
          extension_name: string
          function_name: string
          grantee: string
          privilege_type: string
          schema_name: string
        }[]
      }
      security_audit_function_grants: {
        Args: never
        Returns: {
          function_name: string
          grantee: string
          privilege_type: string
          schema_name: string
        }[]
      }
      security_audit_functions: {
        Args: never
        Returns: {
          arguments: string
          function_name: string
          is_security_definer: boolean
          owner_role: string
          schema_name: string
          search_path_setting: string
        }[]
      }
      security_audit_rls_status: {
        Args: never
        Returns: {
          policy_count: number
          rls_enabled: boolean
          rls_forced: boolean
          schema_name: string
          table_name: string
        }[]
      }
      security_audit_table_grants: {
        Args: never
        Returns: {
          grantee: string
          privilege_type: string
          schema_name: string
          table_name: string
        }[]
      }
      set_online_booking_enabled: {
        Args: { p_enabled: boolean; p_tenant_id: string }
        Returns: boolean
      }
      unlink_salon_assisted_customer_account: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      update_appointment_status: {
        Args: { p_appointment_id: string; p_new_status: string }
        Returns: undefined
      }
      update_membership_role: {
        Args: { p_membership_id: string; p_new_role_id: string }
        Returns: undefined
      }
      update_my_account_profile: {
        Args: { p_full_name: string; p_phone?: string }
        Returns: Json
      }
      update_role_permissions: {
        Args: { p_permission_keys: string[]; p_role_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
