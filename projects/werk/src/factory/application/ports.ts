import type { FactoryMutation, MutationResult } from './mutations.js';
import type { Factory, ProductionLine, LineOverview } from '../../shared/factory.js';
export interface FactoryRegistry {
    mutation<T extends MutationResult>(intent: FactoryMutation, operation: () => T): T;
    factories(): Factory[];
    factory(id: string): Factory;
    createFactory(value: Omit<Factory, 'id'> & {
        id?: string;
    }): Factory;
    updateFactory(id: string, value: Omit<Factory, 'id'>): Factory;
    deleteFactory(id: string): void;
    lines(): ProductionLine[];
    line(id: string): ProductionLine;
    createLine(value: Omit<ProductionLine, 'id'> & {
        id?: string;
    }): ProductionLine;
    updateLine(id: string, value: Omit<ProductionLine, 'id'>): ProductionLine;
    deleteLine(id: string): void;
}
export interface LineReader {
    read(line: ProductionLine): Promise<LineOverview>;
}
